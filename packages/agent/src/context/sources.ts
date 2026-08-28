import type {
  AssistantMessage,
  InstructionPart,
  ModelMessage,
  ToolCall,
} from "@coding-agent/model";
import type { LedgerRecord, SessionBranchView } from "../session/contracts.js";
import type { ArtifactRef, ArtifactStore } from "../tools/contracts.js";
import type {
  ContextContribution,
  ContextOrderingGroup,
  ContextProvenance,
  ContextSensitivity,
  ContextSource,
  ContextSourceInput,
} from "./contracts.js";
import { digestLedgerRecords, sha256 } from "./digests.js";
import { estimateInstructions, estimateMessages, estimateTools } from "./token-estimator.js";

function assistantToolCalls(message: AssistantMessage): readonly ToolCall[] {
  return message.content.filter((part): part is ToolCall => part.type === "tool_call");
}

function messageFromRecord(record: LedgerRecord): ModelMessage | undefined {
  if (record.kind === "user_message") {
    return { role: "user", content: [{ type: "text", text: record.text }] };
  }
  if (record.kind === "assistant_message") return record.message;
  if (record.kind === "tool_outcome") {
    const artifactIds = record.outcome.artifacts.map((artifact) => artifact.id);
    const content =
      artifactIds.length > 0 && record.outcome.modelContent.length > 4_096
        ? `${record.outcome.modelContent.slice(0, 4_096)}\n[ToolOutcome content bounded in Model Context; durable Artifacts: ${artifactIds.join(", ")}]`
        : record.outcome.modelContent;
    return {
      role: "tool",
      callId: record.outcome.callId,
      content,
      isError: record.outcome.isError,
    };
  }
  return undefined;
}

interface ModelTurn {
  readonly records: readonly LedgerRecord[];
  readonly complete: boolean;
}

/** Build indivisible Model Turns. An assistant Tool-call Batch is complete only with every outcome. */
export function completeModelTurns(records: readonly LedgerRecord[]): readonly ModelTurn[] {
  const turns: ModelTurn[] = [];
  let pendingInputs: LedgerRecord[] = [];
  const flushPending = (): void => {
    if (pendingInputs.length === 0) return;
    turns.push({ records: pendingInputs, complete: false });
    pendingInputs = [];
  };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.kind === "user_message") {
      if (pendingInputs[0]?.runId !== undefined && pendingInputs[0].runId !== record.runId) {
        flushPending();
      }
      pendingInputs.push(record);
      continue;
    }
    if (
      record.kind === "model_failure" ||
      record.kind === "run_terminal" ||
      record.kind === "run_boundary" ||
      record.kind === "recovery"
    ) {
      flushPending();
      continue;
    }
    if (record.kind !== "assistant_message") continue;
    if (pendingInputs[0]?.runId !== undefined && pendingInputs[0].runId !== record.runId) {
      flushPending();
    }
    const turnRecords = [...pendingInputs, record];
    pendingInputs = [];
    const expected = assistantToolCalls(record.message).map((call) => call.callId);
    const outcomes = new Map<string, LedgerRecord>();
    let cursor = index + 1;
    while (cursor < records.length && outcomes.size < expected.length) {
      const candidate = records[cursor];
      if (!candidate) break;
      if (candidate.kind === "user_message" || candidate.kind === "assistant_message") break;
      if (
        candidate.kind === "tool_outcome" &&
        expected.includes(candidate.outcome.callId) &&
        !outcomes.has(candidate.outcome.callId)
      ) {
        outcomes.set(candidate.outcome.callId, candidate);
      }
      cursor += 1;
    }
    for (const callId of expected) {
      const outcome = outcomes.get(callId);
      if (outcome) turnRecords.push(outcome);
    }
    turns.push({
      records: turnRecords,
      complete: expected.every((callId) => outcomes.has(callId)),
    });
  }
  flushPending();
  return turns;
}

function transcriptContribution(input: ContextSourceInput, turn: ModelTurn): ContextContribution {
  const visible = turn.records.filter(
    (record) =>
      record.runId !== input.runId ||
      record.kind !== "user_message" ||
      (record.origin !== "current_task" &&
        record.origin !== "steering" &&
        record.origin !== "follow_up"),
  );
  const messages = visible.flatMap((record) => {
    const message = messageFromRecord(record);
    return message ? [message] : [];
  });
  const last = turn.records.at(-1);
  const recordIds = turn.records.map((record) => record.recordId);
  const artifactIds = turn.records.flatMap((record) =>
    record.kind === "tool_outcome" ? record.outcome.artifacts.map((artifact) => artifact.id) : [],
  );
  const boundedToolOutcome = turn.records.some(
    (record) =>
      record.kind === "tool_outcome" &&
      record.outcome.artifacts.length > 0 &&
      record.outcome.modelContent.length > 4_096,
  );
  return {
    id: `transcript-turn:${last?.recordId ?? "empty"}`,
    sourceId: "transcript",
    priority: turn.complete ? 400 + Math.min(300, last?.ledgerSeq ?? 0) : 1_000,
    required: !turn.complete,
    orderingGroup: "conversation",
    sequence: turn.records[0]?.ledgerSeq ?? 0,
    estimatedTokens: estimateMessages(messages),
    provenance: {
      kind: "transcript",
      id: last?.recordId ?? "empty",
      digest: digestLedgerRecords(turn.records),
      recordIds,
      ...(artifactIds.length > 0 ? { artifactIds } : {}),
      ...(boundedToolOutcome ? { attributes: { projection: "bounded_tool_outcome" } } : {}),
    },
    sensitivity: "workspace",
    content: { kind: "messages", messages },
    completeModelTurn: turn.complete,
  };
}

export function createTranscriptContextSource(): ContextSource {
  return {
    id: "transcript",
    async collect(input) {
      return completeModelTurns(input.branch.records)
        .map((turn) => transcriptContribution(input, turn))
        .filter(
          (contribution) =>
            contribution.content?.kind !== "messages" || contribution.content.messages.length > 0,
        );
    },
  };
}

function currentRunUserSource(
  id: "current_task" | "queue",
  origins: readonly ("current_task" | "steering" | "follow_up")[],
  priority: number,
): ContextSource {
  return {
    id,
    async collect(input) {
      return input.branch.records.flatMap((record): readonly ContextContribution[] => {
        if (
          record.runId !== input.runId ||
          record.kind !== "user_message" ||
          !origins.includes(record.origin)
        ) {
          return [];
        }
        const messages: readonly ModelMessage[] = [
          { role: "user", content: [{ type: "text", text: record.text }] },
        ];
        return [
          {
            id: `${id}:${record.recordId}`,
            sourceId: id,
            priority,
            required: true,
            orderingGroup: "conversation",
            sequence: record.ledgerSeq,
            estimatedTokens: estimateMessages(messages),
            provenance: {
              kind: id === "queue" ? "queue" : "session",
              id: record.recordId,
              recordIds: [record.recordId],
              attributes: { origin: record.origin },
            },
            sensitivity: "workspace",
            content: { kind: "messages", messages },
          },
        ];
      });
    },
  };
}

export function createCurrentTaskContextSource(): ContextSource {
  return currentRunUserSource("current_task", ["current_task"], 950);
}

export function createQueueContextSource(): ContextSource {
  return currentRunUserSource("queue", ["steering", "follow_up"], 925);
}

export function createRunBoundaryContextSource(): ContextSource {
  return {
    id: "latest_run_boundary",
    async collect(input) {
      const boundary = [...input.branch.records]
        .reverse()
        .find((record) => record.kind === "run_boundary" && record.runId !== input.runId);
      if (!boundary || boundary.kind !== "run_boundary") return [];
      const report = boundary.report;
      const text = [
        "Latest Run Boundary:",
        `status=${report.status}; reason=${report.terminationReason}`,
        report.finalAnswer ? `result=${report.finalAnswer}` : "",
        report.unfinishedWork.length > 0 ? `unfinished=${report.unfinishedWork.join(" | ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const parts: readonly InstructionPart[] = [{ type: "text", text }];
      return [
        {
          id: `run-boundary:${boundary.recordId}`,
          sourceId: "latest_run_boundary",
          priority: 780,
          required: false,
          orderingGroup: "conversation",
          sequence: boundary.ledgerSeq,
          estimatedTokens: estimateInstructions(parts),
          provenance: {
            kind: "session",
            id: boundary.recordId,
            recordIds: [boundary.recordId],
          },
          sensitivity: "workspace",
          content: { kind: "instructions", parts },
        },
      ];
    },
  };
}

export interface StaticInstructionContribution {
  readonly id: string;
  readonly text: string;
  readonly priority: number;
  readonly required: boolean;
  readonly orderingGroup: ContextOrderingGroup;
  readonly provenance: ContextProvenance;
  readonly sensitivity: ContextSensitivity;
  readonly sequence?: number;
}

export function createStaticInstructionContextSource(
  id: string,
  contributions: readonly StaticInstructionContribution[],
): ContextSource {
  return {
    id,
    async collect() {
      return contributions.map((item) => {
        const parts: readonly InstructionPart[] = [{ type: "text", text: item.text }];
        return {
          id: item.id,
          sourceId: id,
          priority: item.priority,
          required: item.required,
          orderingGroup: item.orderingGroup,
          sequence: item.sequence ?? 0,
          estimatedTokens: estimateInstructions(parts),
          provenance: item.provenance,
          sensitivity: item.sensitivity,
          content: { kind: "instructions" as const, parts },
        } satisfies ContextContribution;
      });
    },
  };
}

export function createSystemToolContextSource(
  instructions: readonly InstructionPart[],
): ContextSource {
  return {
    id: "system_and_tools",
    async collect(input) {
      return [
        {
          id: "system-instructions",
          sourceId: "system_and_tools",
          priority: 1_000,
          required: true,
          orderingGroup: "system",
          sequence: 0,
          estimatedTokens: estimateInstructions(instructions),
          provenance: {
            kind: "configuration",
            id: "system-instructions",
            digest: sha256(instructions),
          },
          sensitivity: "public",
          content: { kind: "instructions", parts: instructions },
        },
        {
          id: "tool-definitions",
          sourceId: "system_and_tools",
          priority: 1_000,
          required: true,
          orderingGroup: "system",
          sequence: 1,
          estimatedTokens: estimateTools(input.tools),
          provenance: {
            kind: "configuration",
            id: "tool-definitions",
            digest: sha256(input.tools),
          },
          sensitivity: "public",
          content: { kind: "tool_definitions", tools: input.tools },
        },
      ];
    },
  };
}

function recordsForCheckpoint(
  branch: SessionBranchView,
  startId: string,
  endId: string,
): readonly LedgerRecord[] {
  const start = branch.records.findIndex((record) => record.recordId === startId);
  const end = branch.records.findIndex((record) => record.recordId === endId);
  return start >= 0 && end >= start ? branch.records.slice(start, end + 1) : [];
}

async function readText(
  store: ArtifactStore,
  ref: ArtifactRef,
  signal: AbortSignal,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of store.read(ref, { signal, maxBytes: 256 * 1_024 })) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function createCheckpointContextSource(store: ArtifactStore): ContextSource {
  return {
    id: "latest_checkpoint",
    async collect(input) {
      const checkpoint = [...input.branch.checkpoints].sort(
        (left, right) => right.sourceEndLedgerSeq - left.sourceEndLedgerSeq,
      )[0];
      if (!checkpoint) return [];
      const source = recordsForCheckpoint(
        input.branch,
        checkpoint.sourceStartRecordId,
        checkpoint.sourceEndRecordId,
      );
      const applicable =
        source.length > 0 &&
        source[0]?.ledgerSeq === checkpoint.sourceStartLedgerSeq &&
        source.at(-1)?.ledgerSeq === checkpoint.sourceEndLedgerSeq &&
        digestLedgerRecords(source) === checkpoint.sourceDigest &&
        input.branch.records.some((record) => record.recordId === checkpoint.branchLeafRecordId);
      const base: Omit<ContextContribution, "content" | "estimatedTokens"> = {
        id: `checkpoint:${checkpoint.checkpointId}`,
        sourceId: "latest_checkpoint",
        priority: 850,
        required: false,
        orderingGroup: "checkpoint",
        sequence: checkpoint.sourceEndLedgerSeq,
        provenance: {
          kind: "checkpoint",
          id: checkpoint.checkpointId,
          digest: checkpoint.summaryDigest,
          recordIds: source.map((record) => record.recordId),
          artifactIds: [checkpoint.summaryArtifact.id],
          attributes: { sourceDigest: checkpoint.sourceDigest },
        },
        sensitivity: "workspace",
      };
      if (!applicable) {
        return [{ ...base, estimatedTokens: 0, unavailableReason: "not_applicable" }];
      }
      const integrity = await store.verify(checkpoint.summaryArtifact);
      if (integrity.status !== "verified") {
        return [
          {
            ...base,
            estimatedTokens: 0,
            unavailableReason:
              integrity.status === "missing" ? "artifact_missing" : "artifact_corrupt",
          },
        ];
      }
      const summary = await readText(store, checkpoint.summaryArtifact, input.signal);
      if (sha256(summary) !== checkpoint.summaryDigest) {
        return [{ ...base, estimatedTokens: 0, unavailableReason: "artifact_corrupt" }];
      }
      const parts: readonly InstructionPart[] = [
        {
          type: "text",
          text: `Lossy Compaction Checkpoint (${checkpoint.checkpointId}):\n${summary}`,
        },
      ];
      return [
        {
          ...base,
          estimatedTokens: estimateInstructions(parts),
          content: { kind: "instructions", parts },
        },
      ];
    },
  };
}

export function createArtifactPreviewContextSource(store: ArtifactStore): ContextSource {
  return {
    id: "artifact_previews",
    async collect(input) {
      const references = new Map<string, { ref: ArtifactRef; sequence: number }>();
      for (const record of input.branch.records) {
        if (record.kind !== "tool_outcome") continue;
        for (const ref of record.outcome.artifacts) {
          references.set(ref.id, { ref, sequence: record.ledgerSeq });
        }
      }
      const contributions: ContextContribution[] = [];
      for (const { ref, sequence } of [...references.values()].sort((a, b) =>
        a.ref.id.localeCompare(b.ref.id),
      )) {
        const integrity = await store.verify(ref);
        const base: Omit<ContextContribution, "content" | "estimatedTokens"> = {
          id: `artifact-preview:${ref.id}`,
          sourceId: "artifact_previews",
          priority: 180 + Math.min(300, sequence),
          required: false,
          orderingGroup: "artifact_previews",
          sequence,
          provenance: { kind: "artifact", id: ref.id, artifactIds: [ref.id] },
          sensitivity: "restricted",
        };
        if (integrity.status !== "verified") {
          contributions.push({
            ...base,
            estimatedTokens: 0,
            unavailableReason:
              integrity.status === "missing" ? "artifact_missing" : "artifact_corrupt",
          });
          continue;
        }
        const metadata = await store.stat(ref);
        const preview = metadata.preview.slice(0, 1_024);
        if (!preview) continue;
        const parts: readonly InstructionPart[] = [
          {
            type: "text",
            text: `Artifact preview ${ref.id} (${metadata.mediaType}, ${metadata.byteLength} bytes):\n${preview}`,
          },
        ];
        contributions.push({
          ...base,
          estimatedTokens: estimateInstructions(parts),
          content: { kind: "instructions", parts },
        });
      }
      return contributions;
    },
  };
}
