import { FastApplication } from "../application/fast-application.js";
import type {
  ModelAdapterFactory,
  ToolPortFactory,
  WorkspaceInspector,
  WorkspaceState,
} from "../application/ports.js";
import { ScriptedModelAdapter, type ScriptedModelStep } from "../model/scripted-model-adapter.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { EmptyToolPort } from "../runtime/tool-port.js";
import type {
  LedgerOperation,
  RunLease,
  SessionLedger,
  SessionSummary,
  SessionView,
  WorkspaceBaseline,
} from "../session/ledger.js";
import { MemorySessionLedger } from "../session/memory-session-ledger.js";
import { DeterministicIdFactory } from "./deterministic-id-factory.js";
import { ManualClock } from "./manual-clock.js";

export interface ScenarioHarnessOptions {
  readonly steps: readonly ScriptedModelStep[];
  readonly maximumModelTurns?: number;
  readonly maximumModelAttempts?: number;
  readonly failFirstRuntimeRecord?: boolean;
  readonly failFirstFinish?: boolean;
  readonly failFirstFinishAfterCommit?: boolean;
  readonly endingChangedFiles?: readonly string[];
}

export class ScenarioHarness {
  private readonly clock = new ManualClock(1_000);
  private readonly adapter: ScriptedModelAdapter;
  private readonly application: FastApplication;

  public constructor(private readonly options: ScenarioHarnessOptions) {
    const ids = new DeterministicIdFactory();
    const memoryLedger = new MemorySessionLedger(ids, this.clock);
    const ledger =
      options.failFirstRuntimeRecord ||
      options.failFirstFinish ||
      options.failFirstFinishAfterCommit
        ? new FaultInjectingSessionLedger(memoryLedger, {
            failFirstRuntimeRecord: options.failFirstRuntimeRecord ?? false,
            failFirstFinish: options.failFirstFinish ?? false,
            failFirstFinishAfterCommit: options.failFirstFinishAfterCommit ?? false,
          })
        : memoryLedger;
    this.adapter = new ScriptedModelAdapter(options.steps, this.clock);
    const models = new SingleScriptedModelFactory(this.adapter);
    const workspace = new ScriptedWorkspaceInspector(options.endingChangedFiles);
    const tools: ToolPortFactory = { create: () => new EmptyToolPort() };
    this.application = new FastApplication(
      ledger,
      new AgentRuntime(),
      models,
      tools,
      workspace,
      this.clock,
      "You are a coding agent.",
    );
  }

  public async run(task: string, options: { readonly abortBeforeRequest?: boolean } = {}) {
    const session = await this.application.openSession({
      kind: "create",
      workspacePath: "C:/scenario-workspace",
      defaultProviderProfile: "scripted",
      defaultModel: "fixture",
    });
    const active = await session.startRun({
      task,
      permissionMode: "safe",
      ...(this.options.maximumModelTurns === undefined
        ? {}
        : { maximumModelTurns: this.options.maximumModelTurns }),
      ...(this.options.maximumModelAttempts === undefined
        ? {}
        : { maximumModelAttempts: this.options.maximumModelAttempts }),
    });
    const abortAck = options.abortBeforeRequest
      ? await active.dispatch({ type: "abort", commandId: "abort-1" })
      : undefined;
    const report = await active.finished;
    const events = [];
    for await (const event of active.events) events.push(event);
    return {
      report,
      events,
      session: await session.inspect(),
      ...(abortAck === undefined ? {} : { abortAck }),
    };
  }

  public assertClean(): void {
    this.adapter.assertComplete();
    this.clock.assertIdle();
    this.application.assertIdle();
  }
}

class FaultInjectingSessionLedger implements SessionLedger {
  private failRuntimeRecord: boolean;
  private failFinish: boolean;
  private failFinishAfterCommit: boolean;

  public constructor(
    private readonly inner: SessionLedger,
    faults: {
      readonly failFirstRuntimeRecord: boolean;
      readonly failFirstFinish: boolean;
      readonly failFirstFinishAfterCommit: boolean;
    },
  ) {
    this.failRuntimeRecord = faults.failFirstRuntimeRecord;
    this.failFinish = faults.failFirstFinish;
    this.failFinishAfterCommit = faults.failFirstFinishAfterCommit;
  }

  public createSession(input: {
    workspace: WorkspaceBaseline;
    defaultProviderProfile: string;
    defaultModel: string;
  }): Promise<SessionSummary> {
    return this.inner.createSession(input);
  }

  public listSessions(): Promise<readonly SessionSummary[]> {
    return this.inner.listSessions();
  }

  public inspectSession(sessionId: string): Promise<SessionView> {
    return this.inner.inspectSession(sessionId);
  }

  public async beginRun(sessionId: string, input: { initialTask: string }): Promise<RunLease> {
    const lease = await this.inner.beginRun(sessionId, input);
    return {
      runId: lease.runId,
      commitAssistant: (message) => lease.commitAssistant(message),
      recordOperation: async (operation: LedgerOperation) => {
        if (this.failRuntimeRecord) {
          this.failRuntimeRecord = false;
          throw new Error("injected persistence failure");
        }
        await lease.recordOperation(operation);
      },
      finish: async (report) => {
        if (this.failFinish) {
          this.failFinish = false;
          throw new Error("injected RunReport finish failure");
        }
        await lease.finish(report);
        if (this.failFinishAfterCommit) {
          this.failFinishAfterCommit = false;
          throw new Error("injected ambiguous RunReport finish failure");
        }
      },
    };
  }
}

class SingleScriptedModelFactory implements ModelAdapterFactory {
  private creates = 0;

  public constructor(private readonly adapter: ScriptedModelAdapter) {}

  public async create(input: { readonly providerProfile: string; readonly model: string }) {
    if (input.providerProfile !== "scripted" || input.model !== "fixture") {
      throw new Error("scripted fixture model is not configured");
    }
    this.creates += 1;
    if (this.creates > 1) {
      throw new Error("ScenarioHarness creates exactly one run-scoped ModelPort");
    }
    return this.adapter;
  }
}

class ScriptedWorkspaceInspector implements WorkspaceInspector {
  private inspections = 0;

  public constructor(private readonly endingChangedFiles?: readonly string[]) {}

  public async inspect(workspacePath: string): Promise<WorkspaceState> {
    this.inspections += 1;
    if (this.inspections >= 3 && this.endingChangedFiles !== undefined) {
      return {
        rootPath: workspacePath.replaceAll("\\", "/"),
        headSha: "b".repeat(40),
        fingerprint: "dirty:b",
        changedFiles: this.endingChangedFiles,
        isClean: false,
      };
    }
    return {
      rootPath: workspacePath.replaceAll("\\", "/"),
      headSha: "a".repeat(40),
      fingerprint: "clean:a",
      changedFiles: [],
      isClean: true,
    };
  }
}
