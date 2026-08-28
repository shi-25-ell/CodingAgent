import { collectModelTurn, type Model, type ModelMessage } from "@coding-agent/model";
import type {
  CompactionCheckInput,
  CompactionInput,
  CompactionResult,
  CompactionStrategy,
  ContextContribution,
  ContextDerivationRecord,
} from "../context/contracts.js";
import { digestLedgerRecords, sha256 } from "../context/digests.js";
import { ContextError } from "../context/errors.js";
import {
  estimateInstructions,
  estimateMessages,
  estimateTextTokens,
} from "../context/token-estimator.js";
import type { IdFactory } from "../contracts/primitives.js";
import type { ArtifactStore } from "../tools/contracts.js";

export interface SummaryCompactionStrategyOptions {
  readonly model: Model;
  readonly artifacts: ArtifactStore;
  readonly ids: IdFactory;
  readonly summaryOutputTokens?: number;
  readonly triggerRatio?: number;
}

function messages(contributions: readonly ContextContribution[]): readonly ModelMessage[] {
  return contributions.flatMap((contribution) =>
    contribution.content?.kind === "messages" ? contribution.content.messages : [],
  );
}

function recordIds(contributions: readonly ContextContribution[]): readonly string[] {
  return contributions.flatMap((contribution) => contribution.provenance.recordIds ?? []);
}

function derivationBase(
  input: CompactionInput,
  options: SummaryCompactionStrategyOptions,
  derivationId: string,
  inputDigest: string,
): Omit<ContextDerivationRecord, "status"> {
  return {
    version: 1,
    derivationId,
    runId: input.request.runId,
    modelAttemptCount: input.request.modelAttemptCount,
    kind: "summary_compaction",
    model: {
      providerId: options.model.descriptor.providerId,
      modelId: options.model.descriptor.modelId,
    },
    inputDigest,
  };
}

function summaryPrompt(input: CompactionInput): string {
  const serialized = JSON.stringify(messages(input.sourceTurns));
  const prior = input.priorCheckpoint
    ? `\nPrevious lossy checkpoint:\n${input.priorCheckpoint.summary}\n`
    : "";
  return [
    "Create a lossy continuation checkpoint from the conversation facts below.",
    "Do not continue the task and do not claim that the checkpoint is a transcript.",
    "Preserve the current objective, constraints, verified results, changed files, pending work, and exact identifiers needed to continue.",
    "Use concise Chinese prose with these headings: 目标与约束、已验证进展、关键决定、未完成工作、继续所需事实。",
    prior,
    `Conversation facts (canonical JSON):\n${serialized}`,
  ].join("\n\n");
}

export function createSummaryCompactionStrategy(
  options: SummaryCompactionStrategyOptions,
): CompactionStrategy {
  const outputTokens = options.summaryOutputTokens ?? 2_048;
  const triggerRatio = options.triggerRatio ?? 0.82;
  if (!Number.isSafeInteger(outputTokens) || outputTokens <= 0) {
    throw new TypeError("summaryOutputTokens 必须是正整数");
  }
  if (!(triggerRatio > 0 && triggerRatio <= 1)) {
    throw new TypeError("compaction triggerRatio 必须在 (0, 1] 范围内");
  }
  return {
    version: "summary-v1",
    async shouldCompact(input: CompactionCheckInput) {
      return (
        input.hasCompactableTurns &&
        (input.totalTokens > input.usableInputBudget ||
          input.totalTokens > Math.floor(input.usableInputBudget * triggerRatio))
      );
    },
    async compact(input): Promise<CompactionResult> {
      if (input.request.signal.aborted) {
        throw new ContextError("CONTEXT_COMPACTION_ABORTED", "Context Derivation 已取消");
      }
      if (
        input.sourceTurns.length === 0 ||
        input.sourceTurns.some((turn) => !turn.completeModelTurn)
      ) {
        throw new ContextError(
          "CONTEXT_COMPACTION_UNAVAILABLE",
          "没有可在完整 Model Turn 边界压缩的历史",
        );
      }
      const sourceIds = recordIds(input.sourceTurns);
      const retainedIds = recordIds(input.retainedTurns);
      const branchRecords = input.request.branch.records;
      const sourceStartId = input.priorCheckpoint?.metadata.sourceStartRecordId ?? sourceIds[0];
      const sourceEndId = sourceIds.at(-1);
      if (!sourceStartId || !sourceEndId) {
        throw new ContextError("CONTEXT_COMPACTION_UNAVAILABLE", "Compaction source range 为空");
      }
      const start = branchRecords.findIndex((record) => record.recordId === sourceStartId);
      const end = branchRecords.findIndex((record) => record.recordId === sourceEndId);
      if (start < 0 || end < start) {
        throw new ContextError(
          "CONTEXT_CHECKPOINT_CORRUPT",
          "Compaction source range 不属于当前 Conversation Branch ancestry",
        );
      }
      const sourceRange = branchRecords.slice(start, end + 1);
      const prompt = summaryPrompt(input);
      const inputDigest = sha256({
        prompt,
        sourceDigest: digestLedgerRecords(sourceRange),
        priorCheckpointId: input.priorCheckpoint?.metadata.checkpointId,
      });
      const derivationId = options.ids.next("context-derivation");
      const base = derivationBase(input, options, derivationId, inputDigest);
      const derivationInputBudget =
        input.budget.modelContextWindow -
        outputTokens -
        input.budget.protocolToolSchemaReserve -
        input.budget.safetyMargin;
      if (estimateTextTokens(prompt) > derivationInputBudget) {
        const derivation: ContextDerivationRecord = {
          ...base,
          status: "failed",
          failureCode: "CONTEXT_DERIVATION_OVERFLOW",
        };
        throw new ContextError(
          "CONTEXT_COMPACTION_FAILED",
          "Summary source 超出 Context Derivation budget，未修改原 Session",
          { derivations: [derivation] },
        );
      }
      const request = {
        version: 1 as const,
        instructions: [
          {
            type: "text" as const,
            text: "你只生成带明确失真属性的 continuation checkpoint，不执行 Coding Task。",
          },
        ],
        messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }] }],
        tools: [],
        toolChoice: { kind: "none" as const },
        output: { maxTokens: outputTokens },
        metadata: { interaction: "context_derivation", derivationId },
      };
      const result = await collectModelTurn(
        options.model.stream(request, { signal: input.request.signal }),
      );
      if (result.status === "failed") {
        const aborted = input.request.signal.aborted || result.failure.category === "cancelled";
        const derivation: ContextDerivationRecord = {
          ...base,
          status: aborted ? "aborted" : "failed",
          failureCode: result.failure.category,
        };
        throw new ContextError(
          aborted ? "CONTEXT_COMPACTION_ABORTED" : "CONTEXT_COMPACTION_FAILED",
          aborted
            ? "Summary Context Derivation 已取消，未修改原 Session"
            : "Summary Context Derivation 失败，未修改原 Session",
          { derivations: [derivation] },
        );
      }
      const summary = result.response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      if (
        summary.length === 0 ||
        result.response.finishReason !== "stop" ||
        result.response.content.some((part) => part.type === "tool_call")
      ) {
        const derivation: ContextDerivationRecord = {
          ...base,
          status: "failed",
          failureCode: "INVALID_SUMMARY_RESPONSE",
        };
        throw new ContextError(
          "CONTEXT_COMPACTION_FAILED",
          "Summary response 不完整或包含 ToolCall，未修改原 Session",
          { derivations: [derivation] },
        );
      }
      const summaryDigest = sha256(summary);
      let summaryArtifact: Awaited<ReturnType<ArtifactStore["put"]>>;
      try {
        if (input.request.signal.aborted) {
          throw new DOMException("Context Derivation 已取消", "AbortError");
        }
        summaryArtifact = await options.artifacts.put(
          {
            bytes: new TextEncoder().encode(summary),
            mediaType: "text/plain",
            provenance: `context-derivation:${derivationId}`,
          },
          { signal: input.request.signal },
        );
        const integrity = await options.artifacts.verify(summaryArtifact);
        if (integrity.status !== "verified")
          throw new Error("summary Artifact integrity 未 verified");
        if (input.request.signal.aborted) {
          throw new DOMException("Context Derivation 已取消", "AbortError");
        }
      } catch (error) {
        const aborted = input.request.signal.aborted;
        const derivation: ContextDerivationRecord = {
          ...base,
          status: aborted ? "aborted" : "failed",
          outputDigest: summaryDigest,
          failureCode: aborted ? "cancelled" : "ARTIFACT_COMMIT_FAILED",
        };
        throw new ContextError(
          aborted ? "CONTEXT_COMPACTION_ABORTED" : "CONTEXT_COMPACTION_FAILED",
          "Summary Artifact 未能完整提交，原 Session 保持不变",
          { cause: error, derivations: [derivation] },
        );
      }
      const checkpointId = options.ids.next("checkpoint");
      const leaf = branchRecords.at(-1);
      if (!leaf)
        throw new ContextError("CONTEXT_COMPACTION_UNAVAILABLE", "Conversation Branch 为空");
      const sourceTokens = estimateTextTokens(prompt);
      const retainedTokens = estimateMessages(messages(input.retainedTurns));
      const summaryParts = [
        {
          type: "text" as const,
          text: `Lossy Compaction Checkpoint (${checkpointId}):\n${summary}`,
        },
      ];
      const checkpoint = {
        version: 1 as const,
        checkpointId,
        runId: input.request.runId,
        branchId: input.request.branch.branch.branchId,
        sourceStartLedgerSeq: sourceRange[0]?.ledgerSeq ?? 0,
        sourceEndLedgerSeq: sourceRange.at(-1)?.ledgerSeq ?? 0,
        sourceStartRecordId: sourceStartId,
        sourceEndRecordId: sourceEndId,
        sourceDigest: digestLedgerRecords(sourceRange),
        branchLeafRecordId: leaf.recordId,
        retainedRecordIds: retainedIds,
        ...(input.priorCheckpoint
          ? { priorCheckpointId: input.priorCheckpoint.metadata.checkpointId }
          : {}),
        strategyVersion: "summary-v1",
        summaryArtifact,
        summaryDigest,
        tokenProvenance: {
          method: "estimated_chars" as const,
          sourceTokens,
          retainedTokens,
          summaryTokens: estimateTextTokens(summary),
        },
      };
      const derivation: ContextDerivationRecord = {
        ...base,
        status: "succeeded",
        outputDigest: summaryDigest,
        checkpointId,
      };
      return {
        checkpoint,
        derivation,
        summaryContribution: {
          id: `checkpoint:${checkpointId}`,
          sourceId: "latest_checkpoint",
          priority: 850,
          required: false,
          orderingGroup: "checkpoint",
          sequence: checkpoint.sourceEndLedgerSeq,
          estimatedTokens: estimateInstructions(summaryParts),
          provenance: {
            kind: "checkpoint",
            id: checkpointId,
            digest: summaryDigest,
            recordIds: sourceRange.map((record) => record.recordId),
            artifactIds: [summaryArtifact.id],
            attributes: { sourceDigest: checkpoint.sourceDigest },
          },
          sensitivity: "workspace",
          content: { kind: "instructions", parts: summaryParts },
        },
      };
    },
  };
}
