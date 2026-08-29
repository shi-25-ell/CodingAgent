import type { RunId, RunPhase } from "@coding-agent/agent";
import type { CodingEvent, CodingSemanticEvent } from "../app/coding-events.js";
import type {
  CodingProjection,
  CodingProjectionDiagnostic,
  CodingRunDisplayStatus,
  CodingRunProjection,
  CodingSessionSnapshot,
  CodingToolProjection,
  LocalUiState,
  TuiViewModel,
} from "./contracts.js";
import { immutableReadonlySet } from "./immutable-readonly-set.js";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function initialRun(runId: RunId): CodingRunProjection {
  return {
    runId,
    phase: "created",
    status: "idle",
    terminal: false,
    tools: {},
    toolOrder: [],
    approvals: {},
    approvalOrder: [],
    compactions: [],
  };
}

function clearAssistantStream(run: CodingRunProjection): CodingRunProjection {
  const { assistantStream: _assistantStream, ...rest } = run;
  return rest;
}

function phaseStatus(phase: RunPhase): CodingRunDisplayStatus {
  switch (phase) {
    case "created":
      return "idle";
    case "preparing_context":
      return "preparing_context";
    case "model_streaming":
      return "streaming";
    case "assistant_committing":
      return "committing";
    case "tool_batch":
    case "safe_point":
      return "tool_activity";
    case "completion_candidate":
    case "finalizing":
      return "finalizing";
    case "terminal":
      return "finalizing";
  }
}

function appendDiagnostic(
  projection: CodingProjection,
  diagnostic: CodingProjectionDiagnostic,
): CodingProjection {
  if (
    projection.diagnostics.some(
      (current) =>
        current.code === diagnostic.code &&
        current.runId === diagnostic.runId &&
        current.message === diagnostic.message,
    )
  ) {
    return projection;
  }
  return { ...projection, diagnostics: [...projection.diagnostics, diagnostic] };
}

function updateRun(
  projection: CodingProjection,
  runId: RunId,
  update: (run: CodingRunProjection) => CodingRunProjection,
): CodingProjection {
  const existing = projection.runs[runId] ?? initialRun(runId);
  const run = update(existing);
  return {
    ...projection,
    runs: { ...projection.runs, [runId]: run },
    runOrder: projection.runOrder.includes(runId)
      ? projection.runOrder
      : [...projection.runOrder, runId],
  };
}

function applySemantic(projection: CodingProjection, event: CodingSemanticEvent): CodingProjection {
  const last = projection.semanticSequences[event.runId] ?? 0;
  if (event.sequence <= last) return projection;
  let next = projection;
  if (event.sequence !== last + 1) {
    next = appendDiagnostic(next, {
      code: "SEMANTIC_SEQUENCE_GAP",
      runId: event.runId,
      message: `expected ${last + 1}, received ${event.sequence}`,
    });
    next = { ...next, requiresSnapshot: true };
  }
  next = {
    ...next,
    semanticSequences: { ...next.semanticSequences, [event.runId]: event.sequence },
  };
  switch (event.type) {
    case "run_started":
      return updateRun({ ...next, activeRunId: event.runId }, event.runId, (run) => ({
        ...run,
        config: event.config,
        phase: "created",
        status: "idle",
      }));
    case "user_accepted":
      return next;
    case "assistant_committed": {
      const blockId = `ledger:${event.ledgerSeq}`;
      const transcript = next.transcript.some((block) => block.id === blockId)
        ? next.transcript
        : [
            ...next.transcript,
            {
              id: blockId,
              runId: event.runId,
              ledgerSeq: event.ledgerSeq,
              kind: "assistant" as const,
              assistant: event.message,
            },
          ];
      return updateRun({ ...next, transcript }, event.runId, clearAssistantStream);
    }
    case "tool_planned":
      return updateRun(next, event.runId, (run) => ({
        ...run,
        status: run.terminal ? run.status : "tool_activity",
        tools: {
          ...run.tools,
          [event.plan.callId]: {
            ...(run.tools[event.plan.callId] ?? {}),
            callId: event.plan.callId,
            plan: event.plan,
            status: "planned",
          },
        },
        toolOrder: run.toolOrder.includes(event.plan.callId)
          ? run.toolOrder
          : [...run.toolOrder, event.plan.callId],
      }));
    case "tool_started":
      return updateRun(next, event.runId, (run) => {
        const tool = run.tools[event.callId];
        if (!tool) return run;
        return {
          ...run,
          status: run.terminal ? run.status : "tool_activity",
          tools: { ...run.tools, [event.callId]: { ...tool, status: "running" } },
        };
      });
    case "tool_settled": {
      const blockId = `ledger:${event.ledgerSeq}`;
      const transcript = next.transcript.some((block) => block.id === blockId)
        ? next.transcript
        : [
            ...next.transcript,
            {
              id: blockId,
              runId: event.runId,
              ledgerSeq: event.ledgerSeq,
              kind: "tool" as const,
              outcome: event.outcome,
            },
          ];
      return updateRun({ ...next, transcript }, event.runId, (run) => {
        const prior = run.tools[event.outcome.callId];
        const priorPlan = prior?.plan ?? {
          callId: event.outcome.callId,
          toolName: "unknown",
          resources: [],
          effects: [],
          risks: [],
        };
        const plan = {
          ...priorPlan,
          resources: [],
          effects: Array.isArray(event.outcome.evidence?.effects)
            ? event.outcome.evidence.effects.filter(
                (effect): effect is CodingToolProjection["plan"]["effects"][number] =>
                  effect === "workspace_read" ||
                  effect === "workspace_mutation" ||
                  effect === "process" ||
                  effect === "git_evidence" ||
                  effect === "network",
              )
            : [],
          risks: [],
          ...(typeof event.outcome.evidence?.planFingerprint === "string"
            ? { fingerprint: event.outcome.evidence.planFingerprint }
            : {}),
        };
        return {
          ...run,
          tools: {
            ...run.tools,
            [event.outcome.callId]: {
              callId: event.outcome.callId,
              plan,
              status: "settled",
              ...(prior?.progress ? { progress: prior.progress } : {}),
              outcome: event.outcome,
            },
          },
          toolOrder: run.toolOrder.includes(event.outcome.callId)
            ? run.toolOrder
            : [...run.toolOrder, event.outcome.callId],
        };
      });
    }
    case "permission_requested":
      return updateRun(next, event.runId, (run) => ({
        ...run,
        status: run.terminal ? run.status : "awaiting_approval",
        approvals: { ...run.approvals, [event.approval.approvalId]: event.approval },
        approvalOrder: run.approvalOrder.includes(event.approval.approvalId)
          ? run.approvalOrder
          : [...run.approvalOrder, event.approval.approvalId],
        tools: {
          ...run.tools,
          [event.approval.callId]: {
            ...(run.tools[event.approval.callId] ?? {
              callId: event.approval.callId,
              status: "planned" as const,
            }),
            plan: event.approval.plan,
          },
        },
      }));
    case "permission_resolved":
      return updateRun(next, event.runId, (run) => {
        const approval = run.approvals[event.approvalId];
        if (!approval) return run;
        return {
          ...run,
          status: run.terminal ? run.status : phaseStatus(run.phase),
          approvals: {
            ...run.approvals,
            [event.approvalId]: { ...approval, status: event.status },
          },
        };
      });
    case "queue_changed":
    case "queue_delivered": {
      const index = next.queues.findIndex((item) => item.commandId === event.item.commandId);
      const queues =
        index < 0
          ? [...next.queues, event.item]
          : next.queues.map((item, itemIndex) => (itemIndex === index ? event.item : item));
      return { ...next, queues };
    }
    case "context_prepared":
      return updateRun(next, event.runId, (run) => ({
        ...run,
        context: {
          manifest: event.manifest,
          measurement: event.measurement,
          ...(event.checkpoint ? { checkpoint: event.checkpoint } : {}),
          derivations: event.derivations,
        },
      }));
    case "compaction_completed":
    case "compaction_failed":
      return updateRun(next, event.runId, (run) => ({
        ...run,
        status: run.terminal ? run.status : phaseStatus(run.phase),
        compactions: run.compactions.some(
          (item) => item.derivationId === event.derivation.derivationId,
        )
          ? run.compactions
          : [...run.compactions, event.derivation],
      }));
    case "model_failure_committed":
      return updateRun(
        {
          ...next,
          transcript: next.transcript.some((block) => block.id === `ledger:${event.ledgerSeq}`)
            ? next.transcript
            : [
                ...next.transcript,
                {
                  id: `ledger:${event.ledgerSeq}`,
                  runId: event.runId,
                  ledgerSeq: event.ledgerSeq,
                  kind: "model_failure" as const,
                  failure: event.failure,
                },
              ],
        },
        event.runId,
        (run) => ({ ...run, modelFailure: event.failure }),
      );
    case "recovery_observed":
      return updateRun(next, event.runId, (run) => ({
        ...run,
        phase: "terminal",
        status: "recovering",
        terminal: true,
        recovery: event.diagnostic,
      }));
    case "session_updated": {
      const base = {
        ...next,
        revision: event.revision,
        currentBranchId: event.currentBranchId,
        branches: event.branches,
      };
      if (event.activeRunId) return { ...base, activeRunId: event.activeRunId };
      const { activeRunId: _activeRunId, ...withoutActiveRun } = base;
      return withoutActiveRun;
    }
    case "terminal_committed": {
      const terminalBase =
        next.activeRunId === event.runId
          ? (({ activeRunId: _activeRunId, ...rest }) => rest)(next)
          : next;
      return updateRun(terminalBase, event.runId, (run) => ({
        ...clearAssistantStream(run),
        phase: "terminal",
        status: event.report.status,
        terminal: true,
        approvals: {},
        approvalOrder: [],
        report: event.report,
      }));
    }
  }
}

function applyProgress(
  projection: CodingProjection,
  event: Exclude<CodingEvent, CodingSemanticEvent>,
) {
  const revisionKey = `${event.runId}:${event.key}`;
  const lastRevision = projection.progressRevisions[revisionKey] ?? 0;
  if (event.revision <= lastRevision) return projection;
  const next: CodingProjection = {
    ...projection,
    progressRevisions: { ...projection.progressRevisions, [revisionKey]: event.revision },
  };
  const run = next.runs[event.runId] ?? initialRun(event.runId);
  if (run.terminal) {
    return appendDiagnostic(next, {
      code: "LATE_PROGRESS_IGNORED",
      runId: event.runId,
      message: event.key,
    });
  }
  switch (event.type) {
    case "phase_changed":
      return updateRun(next, event.runId, (current) => ({
        ...current,
        phase: event.phase,
        status: phaseStatus(event.phase),
      }));
    case "model_attempt_started":
      return updateRun(next, event.runId, (current) => ({
        ...current,
        assistantStream: {
          modelTurnCount: event.modelTurnCount,
          modelAttemptCount: event.modelAttemptCount,
          text: "",
          reasoning: "",
        },
      }));
    case "assistant_delta":
      return updateRun(next, event.runId, (current) => {
        const stream = current.assistantStream;
        if (
          stream &&
          (event.modelAttemptCount < stream.modelAttemptCount ||
            event.modelTurnCount < stream.modelTurnCount)
        ) {
          return current;
        }
        const active =
          stream &&
          stream.modelTurnCount === event.modelTurnCount &&
          stream.modelAttemptCount === event.modelAttemptCount
            ? stream
            : {
                modelTurnCount: event.modelTurnCount,
                modelAttemptCount: event.modelAttemptCount,
                text: "",
                reasoning: "",
              };
        return {
          ...current,
          status: "streaming",
          assistantStream: {
            ...active,
            [event.channel]: active[event.channel] + event.delta,
          },
        };
      });
    case "tool_update":
      return updateRun(next, event.runId, (current) => {
        const tool = current.tools[event.callId];
        if (!tool || tool.status === "settled") return current;
        return {
          ...current,
          tools: {
            ...current.tools,
            [event.callId]: { ...tool, progress: event.update.message },
          },
        };
      });
    case "compaction_progress":
      return updateRun(next, event.runId, (current) => ({
        ...current,
        status: "compacting",
      }));
  }
}

export function reduceProjection(
  previous: CodingProjection | undefined,
  input: CodingSessionSnapshot | CodingEvent,
): CodingProjection {
  if (!("category" in input)) {
    return freeze({
      ...input,
      runs: { ...input.runs },
      runOrder: [...input.runOrder],
      transcript: [...input.transcript],
      queues: [...input.queues],
      semanticSequences: { ...(input.eventCursors ?? {}) },
      progressRevisions: {},
      diagnostics: [],
      requiresSnapshot: false,
    });
  }
  if (!previous) throw new TypeError("event projection 需要先应用 CodingSessionSnapshot");
  return freeze(
    input.category === "semantic" ? applySemantic(previous, input) : applyProgress(previous, input),
  );
}

export function replayProjection(
  snapshot: CodingSessionSnapshot,
  events: Iterable<CodingEvent>,
): CodingProjection {
  let projection = reduceProjection(undefined, snapshot);
  for (const event of events) projection = reduceProjection(projection, event);
  return projection;
}

export function selectTuiViewModel(
  projection: CodingProjection,
  local: LocalUiState = {},
): TuiViewModel {
  const active = projection.activeRunId
    ? projection.runs[projection.activeRunId]
    : projection.runOrder.length > 0
      ? projection.runs[projection.runOrder.at(-1) as RunId]
      : undefined;
  const tools: CodingToolProjection[] = active
    ? active.toolOrder.flatMap((callId) => {
        const tool = active.tools[callId];
        return tool ? [tool] : [];
      })
    : [];
  const approvals = active
    ? active.approvalOrder.flatMap((approvalId) => {
        const approval = active.approvals[approvalId];
        return approval ? [approval] : [];
      })
    : [];
  const dismissedDiagnosticIds = local.dismissedDiagnosticIds ?? immutableReadonlySet<string>();
  const projectionDiagnostics: TuiViewModel["diagnostics"] = projection.diagnostics
    .filter((diagnostic) => diagnostic.code === "SEMANTIC_SEQUENCE_GAP")
    .map((diagnostic) => ({
      id: `projection:${diagnostic.code}:${diagnostic.runId}:${diagnostic.message}`,
      source: "projection",
      severity: "error",
      code: diagnostic.code,
      message: diagnostic.message,
      recoverable: true,
    }));
  const diagnostics = [...projectionDiagnostics, ...(local.diagnostics ?? [])].filter(
    (diagnostic) => !dismissedDiagnosticIds.has(diagnostic.id),
  );
  return freeze({
    version: 1,
    session: {
      ref: projection.ref,
      workspace: projection.workspace,
      revision: projection.revision,
      currentBranchId: projection.currentBranchId,
      branches: projection.branches,
    },
    ...(active
      ? {
          activeRun: {
            runId: active.runId,
            status: active.status,
            phase: active.phase,
            ...(active.config ? { config: active.config } : {}),
            ...(active.assistantStream ? { assistantStream: active.assistantStream } : {}),
          },
        }
      : {}),
    transcript: projection.transcript,
    tools,
    approvals,
    queues: projection.queues,
    ...(active?.context ? { context: active.context } : {}),
    ...(active?.report ? { terminalReport: active.report } : {}),
    diagnostics,
    ui: {
      focusedRegion: local.focusedRegion ?? "composer",
      expandedIds: immutableReadonlySet(local.expandedIds),
      composer: local.composer ?? { value: "", revision: 0, deliveryMode: "steering" },
      ...(local.approvalPrompt ? { approvalPrompt: local.approvalPrompt } : {}),
      ...(local.diffViewer ? { diffViewer: local.diffViewer } : {}),
      transcriptViewport: local.transcriptViewport ?? {
        scrollTop: 0,
        followTail: true,
        unseenBlockCount: 0,
      },
      surfaceStack: local.surfaceStack ?? [],
      terminal: local.terminal ?? { width: 80, height: 24 },
      ...(local.selectedModel ? { selectedModel: local.selectedModel } : {}),
      sidebar: local.sidebar ?? { preference: "auto", open: false },
      themeId: local.themeId ?? "dex",
      toolDisplay: local.toolDisplay ?? { showDetails: true, showGenericOutput: false },
    },
  });
}
