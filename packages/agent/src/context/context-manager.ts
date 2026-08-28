import type { InstructionPart, ModelMessage, ModelToolDefinition } from "@coding-agent/model";
import type { CompactionCheckpointMetadata } from "../session/contracts.js";
import type {
  ContextBudget,
  ContextContribution,
  ContextDerivationRecord,
  ContextManager,
  ContextManagerOptions,
  ContextManifestContribution,
  ContextPrepareInput,
  PreparedContext,
} from "./contracts.js";
import { sha256 } from "./digests.js";
import { ContextError } from "./errors.js";
import { estimateRequestInput, estimateTools } from "./token-estimator.js";

const groupOrder: Readonly<Record<ContextContribution["orderingGroup"], number>> = {
  system: 0,
  project_instructions: 10,
  skills: 20,
  checkpoint: 30,
  conversation: 40,
  artifact_previews: 50,
};

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ContextError("CONTEXT_INVALID_CONFIGURATION", `${name} 必须是正整数`);
  }
}

function validateContribution(contribution: ContextContribution, sourceId: string): void {
  if (contribution.sourceId !== sourceId || contribution.id.trim().length === 0) {
    throw new ContextError(
      "CONTEXT_INVALID_CONTRIBUTION",
      `ContextSource ${sourceId} 返回了无效 source/id`,
    );
  }
  if (!Number.isFinite(contribution.priority) || !Number.isSafeInteger(contribution.sequence)) {
    throw new ContextError(
      "CONTEXT_INVALID_CONTRIBUTION",
      `Context contribution ${contribution.id} priority/sequence 无效`,
    );
  }
  if (!Number.isSafeInteger(contribution.estimatedTokens) || contribution.estimatedTokens < 0) {
    throw new ContextError(
      "CONTEXT_INVALID_CONTRIBUTION",
      `Context contribution ${contribution.id} token estimate 无效`,
    );
  }
  if ((contribution.content === undefined) === (contribution.unavailableReason === undefined)) {
    throw new ContextError(
      "CONTEXT_INVALID_CONTRIBUTION",
      `Context contribution ${contribution.id} 必须恰有 content 或 unavailableReason`,
    );
  }
}

function compareContextOrder(left: ContextContribution, right: ContextContribution): number {
  return (
    groupOrder[left.orderingGroup] - groupOrder[right.orderingGroup] ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id)
  );
}

function compareSelection(left: ContextContribution, right: ContextContribution): number {
  return (
    right.priority - left.priority ||
    compareContextOrder(left, right) ||
    left.sourceId.localeCompare(right.sourceId)
  );
}

function checkpointId(contribution: ContextContribution): string | undefined {
  return contribution.sourceId === "latest_checkpoint" &&
    contribution.provenance.kind === "checkpoint"
    ? contribution.provenance.id
    : undefined;
}

function checkpointFor(
  input: ContextPrepareInput,
  contribution: ContextContribution | undefined,
): CompactionCheckpointMetadata | undefined {
  const id = contribution ? checkpointId(contribution) : undefined;
  return id
    ? input.branch.checkpoints.find((candidate) => candidate.checkpointId === id)
    : undefined;
}

function recordSeq(input: ContextPrepareInput, id: string): number | undefined {
  return input.branch.records.find((record) => record.recordId === id)?.ledgerSeq;
}

function afterCheckpoint(
  input: ContextPrepareInput,
  contribution: ContextContribution,
  checkpoint: CompactionCheckpointMetadata,
): boolean {
  const ids = contribution.provenance.recordIds ?? [];
  return ids.some((id) => (recordSeq(input, id) ?? 0) > checkpoint.sourceEndLedgerSeq);
}

function summaryText(contribution: ContextContribution): string | undefined {
  if (contribution.content?.kind !== "instructions") return undefined;
  const text = contribution.content.parts.map((part) => part.text).join("\n");
  const separator = text.indexOf(":\n");
  return separator >= 0 ? text.slice(separator + 2) : text;
}

function manifestEntry(
  contribution: ContextContribution,
  disposition: ContextManifestContribution["disposition"],
  reason: ContextManifestContribution["reason"],
): ContextManifestContribution {
  return {
    contributionId: contribution.id,
    sourceId: contribution.sourceId,
    disposition,
    reason,
    priority: contribution.priority,
    required: contribution.required,
    orderingGroup: contribution.orderingGroup,
    estimatedTokens: contribution.estimatedTokens,
    provenance: contribution.provenance,
    sensitivity: contribution.sensitivity,
  };
}

function retainedTail(
  turns: readonly ContextContribution[],
  targetTokens: number,
): readonly ContextContribution[] {
  const retained: ContextContribution[] = [];
  let tokens = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    if (retained.length > 0 && tokens + turn.estimatedTokens > targetTokens) break;
    retained.unshift(turn);
    tokens += turn.estimatedTokens;
  }
  return retained;
}

async function collect(
  options: ContextManagerOptions,
  input: ContextPrepareInput,
): Promise<ContextContribution[]> {
  const collected: ContextContribution[] = [];
  const ids = new Set<string>();
  for (const source of options.sources) {
    if (input.signal.aborted) {
      throw new ContextError("CONTEXT_COMPACTION_ABORTED", "Context preparation 已取消");
    }
    let contributions: readonly ContextContribution[];
    try {
      contributions = await source.collect(input);
    } catch (error) {
      throw new ContextError("CONTEXT_SOURCE_FAILURE", `ContextSource ${source.id} 收集失败`, {
        cause: error,
      });
    }
    for (const contribution of contributions) {
      validateContribution(contribution, source.id);
      if (ids.has(contribution.id)) {
        throw new ContextError(
          "CONTEXT_INVALID_CONTRIBUTION",
          `Context contribution id 冲突: ${contribution.id}`,
        );
      }
      ids.add(contribution.id);
      collected.push(contribution);
    }
  }
  return collected;
}

export function createContextManager(options: ContextManagerOptions): ContextManager {
  validatePositiveInteger(options.modelContextWindow, "modelContextWindow");
  validatePositiveInteger(options.requestedOutputReserve, "requestedOutputReserve");
  validatePositiveInteger(options.safetyMargin, "safetyMargin");
  validatePositiveInteger(options.retainedTailTokens, "retainedTailTokens");
  if (options.requestedOutputReserve >= options.modelContextWindow) {
    throw new ContextError(
      "CONTEXT_INVALID_CONFIGURATION",
      "requestedOutputReserve 必须小于 modelContextWindow",
    );
  }
  const sourceIds = options.sources.map((source) => source.id);
  if (
    sourceIds.some((id) => id.trim().length === 0) ||
    new Set(sourceIds).size !== sourceIds.length
  ) {
    throw new ContextError(
      "CONTEXT_INVALID_CONFIGURATION",
      "ContextSource id 必须非空且在 pipeline 中唯一",
    );
  }

  return {
    async prepare(input): Promise<PreparedContext> {
      if (input.signal.aborted) {
        throw new ContextError("CONTEXT_COMPACTION_ABORTED", "Context preparation 已取消");
      }
      const contributions = await collect(options, input);
      const toolContributions = contributions.filter(
        (contribution) => contribution.content?.kind === "tool_definitions",
      );
      if (toolContributions.length !== 1) {
        throw new ContextError(
          "CONTEXT_INVALID_CONTRIBUTION",
          "Context pipeline 必须恰好提供一个 tool definitions contribution",
        );
      }
      const toolContribution = toolContributions[0];
      if (
        toolContribution?.content?.kind !== "tool_definitions" ||
        sha256(toolContribution.content.tools) !== sha256(input.tools)
      ) {
        throw new ContextError(
          "CONTEXT_INVALID_CONTRIBUTION",
          "Context tool definitions 与 active ToolExecutor snapshot 不一致",
        );
      }
      const protocolToolSchemaReserve = 32 + estimateTools(input.tools);
      const usableInputBudget =
        options.modelContextWindow -
        options.requestedOutputReserve -
        protocolToolSchemaReserve -
        options.safetyMargin;
      const budget: ContextBudget = {
        modelContextWindow: options.modelContextWindow,
        requestedOutputReserve: options.requestedOutputReserve,
        protocolToolSchemaReserve,
        safetyMargin: options.safetyMargin,
        usableInputBudget,
      };
      if (usableInputBudget <= 0) {
        throw new ContextError(
          "CONTEXT_OVERFLOW",
          "model context window 无法容纳 output、protocol/tool schema reserve 与 safety margin",
        );
      }

      const dispositions = new Map<string, ContextManifestContribution>();
      const unavailable = contributions.filter((contribution) => contribution.unavailableReason);
      for (const contribution of unavailable) {
        const unavailableReason = contribution.unavailableReason;
        if (!unavailableReason) continue;
        if (contribution.required) {
          throw new ContextError(
            "CONTEXT_SOURCE_FAILURE",
            `required contribution ${contribution.id} unavailable: ${contribution.unavailableReason}`,
          );
        }
        dispositions.set(
          contribution.id,
          manifestEntry(
            contribution,
            "omitted",
            unavailableReason === "not_applicable"
              ? "checkpoint_not_applicable"
              : unavailableReason,
          ),
        );
      }
      let available = contributions.filter(
        (contribution) => !contribution.unavailableReason && contribution !== toolContribution,
      );
      let applicableCheckpoint = available.find(
        (contribution) => contribution.sourceId === "latest_checkpoint",
      );
      let priorMetadata = checkpointFor(input, applicableCheckpoint);
      if (applicableCheckpoint && priorMetadata) {
        const selectedPriorMetadata = priorMetadata;
        for (const turn of available.filter(
          (contribution) => contribution.sourceId === "transcript",
        )) {
          if (!afterCheckpoint(input, turn, selectedPriorMetadata)) {
            dispositions.set(turn.id, manifestEntry(turn, "compacted", "replaced_by_checkpoint"));
          }
        }
        available = available.filter(
          (contribution) =>
            contribution.sourceId !== "transcript" ||
            afterCheckpoint(input, contribution, selectedPriorMetadata),
        );
      }

      const history = available.filter(
        (contribution) =>
          contribution.sourceId === "transcript" || contribution.sourceId === "latest_checkpoint",
      );
      const requiredNonHistory = available.filter(
        (contribution) => contribution.required && !history.includes(contribution),
      );
      const historyAndRequiredTokens = [...history, ...requiredNonHistory].reduce(
        (sum, contribution) => sum + contribution.estimatedTokens,
        0,
      );
      const freshTurns = available.filter(
        (contribution) => contribution.sourceId === "transcript" && contribution.completeModelTurn,
      );
      const shouldCompact = await options.compaction.shouldCompact({
        totalTokens: historyAndRequiredTokens,
        usableInputBudget,
        transcriptTokens: freshTurns.reduce(
          (sum, contribution) => sum + contribution.estimatedTokens,
          0,
        ),
        hasCompactableTurns: freshTurns.length > 0,
      });
      let checkpoint: CompactionCheckpointMetadata | undefined;
      const derivations: ContextDerivationRecord[] = [];
      if (shouldCompact) {
        let retained = retainedTail(freshTurns, options.retainedTailTokens);
        let sourceTurns = freshTurns.slice(0, freshTurns.length - retained.length);
        if (sourceTurns.length === 0 && retained.length > 0) {
          sourceTurns = retained.slice(0, 1);
          retained = retained.slice(1);
        }
        if (sourceTurns.length === 0) {
          throw new ContextError(
            "CONTEXT_OVERFLOW",
            "最低合法 Context 超限，且没有可压缩的完整 Model Turn",
          );
        }
        const priorSummary = applicableCheckpoint ? summaryText(applicableCheckpoint) : undefined;
        const result = await options.compaction.compact({
          request: input,
          sourceTurns,
          retainedTurns: retained,
          ...(applicableCheckpoint && priorMetadata && priorSummary
            ? { priorCheckpoint: { metadata: priorMetadata, summary: priorSummary } }
            : {}),
          budget,
        });
        checkpoint = result.checkpoint;
        derivations.push(result.derivation);
        for (const turn of sourceTurns) {
          dispositions.set(turn.id, manifestEntry(turn, "compacted", "replaced_by_checkpoint"));
        }
        if (applicableCheckpoint) {
          dispositions.set(
            applicableCheckpoint.id,
            manifestEntry(applicableCheckpoint, "compacted", "replaced_by_checkpoint"),
          );
        }
        available = available.filter(
          (contribution) =>
            !sourceTurns.includes(contribution) && contribution !== applicableCheckpoint,
        );
        applicableCheckpoint = result.summaryContribution;
        priorMetadata = result.checkpoint;
        available.push(result.summaryContribution);
        contributions.push(result.summaryContribution);
      }

      const selected: ContextContribution[] = [];
      const mandatory = available.filter(
        (contribution) =>
          contribution.required ||
          contribution.sourceId === "transcript" ||
          contribution.sourceId === "latest_checkpoint",
      );
      const mandatoryTokens = mandatory.reduce(
        (sum, contribution) => sum + contribution.estimatedTokens,
        0,
      );
      if (mandatoryTokens > usableInputBudget) {
        const failedDerivations = derivations.map((derivation) => {
          const { checkpointId: _checkpointId, ...withoutCheckpoint } = derivation;
          return {
            ...withoutCheckpoint,
            status: "failed" as const,
            failureCode: "CONTEXT_POST_COMPACTION_OVERFLOW",
          };
        });
        throw new ContextError(
          "CONTEXT_OVERFLOW",
          "最低合法 Model Context 超出 usable input budget；required content 与完整 Model Turn 未被截断",
          failedDerivations.length > 0 ? { derivations: failedDerivations } : undefined,
        );
      }
      let usedTokens = mandatoryTokens;
      selected.push(...mandatory);
      for (const contribution of available
        .filter((candidate) => !mandatory.includes(candidate))
        .sort(compareSelection)) {
        if (usedTokens + contribution.estimatedTokens <= usableInputBudget) {
          selected.push(contribution);
          usedTokens += contribution.estimatedTokens;
        } else {
          dispositions.set(
            contribution.id,
            manifestEntry(contribution, "omitted", "budget_exhausted"),
          );
        }
      }
      if (toolContribution) selected.push(toolContribution);
      for (const contribution of selected) {
        dispositions.set(
          contribution.id,
          manifestEntry(
            contribution,
            "selected",
            contribution.required ? "required" : "within_budget",
          ),
        );
      }
      const ordered = [...selected].sort(compareContextOrder);
      const instructions: InstructionPart[] = ordered.flatMap((contribution) =>
        contribution.content?.kind === "instructions" ? [...contribution.content.parts] : [],
      );
      const messages: ModelMessage[] = ordered.flatMap((contribution) =>
        contribution.content?.kind === "messages" ? [...contribution.content.messages] : [],
      );
      const tools: readonly ModelToolDefinition[] =
        toolContribution?.content?.kind === "tool_definitions"
          ? toolContribution.content.tools
          : input.tools;
      const request = {
        version: 1 as const,
        instructions,
        messages,
        tools,
        output: { maxTokens: options.requestedOutputReserve },
        metadata: {
          contextManifestId: `${input.runId}:attempt-${input.modelAttemptCount}`,
        },
      };
      const requestDigest = sha256(request);
      const contributionManifest = contributions
        .map(
          (contribution) =>
            dispositions.get(contribution.id) ??
            manifestEntry(contribution, "omitted", "budget_exhausted"),
        )
        .sort((left, right) => left.contributionId.localeCompare(right.contributionId));
      const selectedRecordIds = [
        ...new Set(selected.flatMap((contribution) => contribution.provenance.recordIds ?? [])),
      ];
      const selectedCheckpointIds = [
        ...new Set(selected.map(checkpointId).filter((id): id is string => id !== undefined)),
      ];
      const selectedArtifactIds = [
        ...new Set(selected.flatMap((contribution) => contribution.provenance.artifactIds ?? [])),
      ];
      const optionalTokens = selected
        .filter((contribution) => !contribution.required)
        .reduce((sum, contribution) => sum + contribution.estimatedTokens, 0);
      const requiredTokens = selected
        .filter((contribution) => contribution.required && contribution !== toolContribution)
        .reduce((sum, contribution) => sum + contribution.estimatedTokens, 0);
      return {
        request,
        manifest: {
          version: 2,
          id: `${input.runId}:attempt-${input.modelAttemptCount}`,
          runId: input.runId,
          modelAttemptCount: input.modelAttemptCount,
          budget,
          contributions: contributionManifest,
          selectedRecordIds,
          selectedCheckpointIds,
          selectedArtifactIds,
          omitted: contributionManifest
            .filter((entry) => entry.disposition !== "selected")
            .map((entry) => ({ source: entry.sourceId, reason: entry.reason })),
          requestDigest,
        },
        measurement: {
          method: "estimated_chars",
          inputTokens: estimateRequestInput(request),
          outputReserve: options.requestedOutputReserve,
          protocolToolSchemaReserve,
          safetyMargin: options.safetyMargin,
          usableInputBudget,
          requiredTokens,
          optionalTokens,
        },
        ...(checkpoint ? { checkpoint } : {}),
        derivations,
      };
    },
  };
}
