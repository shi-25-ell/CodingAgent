import type { ModelRef } from "@coding-agent/model";
import type { CodingCommandAck, CodingRunHandle, CodingSession } from "../../app/coding-agent.js";
import {
  type CodingProjection,
  reduceProjection,
  selectTuiViewModel,
  type TuiDiagnostic,
  type TuiViewModel,
} from "../../projection/index.js";
import type {
  InteractiveLocalState,
  InteractiveLocalStateOptions,
  UiApplicationIntent,
  UiIntent,
  UiLocalIntent,
} from "./contracts.js";
import {
  appendInteractiveDiagnostic,
  createInteractiveLocalState,
  observeTranscriptGrowth,
  reduceInteractiveLocalState,
} from "./local-ui-state.js";

export interface UiIntentResult {
  readonly version: 1;
  readonly intentType: UiIntent["type"];
  readonly status: "applied" | "unchanged" | "rejected";
  readonly commandAck?: CodingCommandAck;
  readonly message?: string;
}

export interface InteractiveControllerDiagnostics {
  readonly listenerFailureCount: number;
  readonly projectionResyncCount: number;
  readonly intentFailureCount: number;
}

export interface InteractiveControllerOptions extends InteractiveLocalStateOptions {
  readonly session: CodingSession;
  readonly createCommandId?: () => string;
  readonly onQuit?: () => void | Promise<void>;
}

export interface InteractiveController {
  start(): Promise<TuiViewModel>;
  current(): TuiViewModel;
  subscribe(listener: (viewModel: TuiViewModel) => void): () => void;
  dispatch(intent: UiIntent): Promise<UiIntentResult>;
  diagnostics(): InteractiveControllerDiagnostics;
  dispose(): Promise<void>;
}

const localIntentTypes: ReadonlySet<UiLocalIntent["type"]> = new Set([
  "focus_region",
  "set_expanded",
  "composer_changed",
  "transcript_viewport_changed",
  "open_surface",
  "close_surface",
  "terminal_resized",
  "dismiss_diagnostic",
  "select_model",
  "set_sidebar_preference",
  "set_sidebar_open",
]);

function isLocalIntent(intent: UiIntent): intent is UiLocalIntent {
  return localIntentTypes.has(intent.type as UiLocalIntent["type"]);
}

function commandAccepted(ack: CodingCommandAck): boolean {
  return ack.status === "accepted" || ack.status === "already_applied";
}

class ProductionInteractiveController implements InteractiveController {
  readonly #session: CodingSession;
  readonly #createCommandId: () => string;
  readonly #onQuit: () => void | Promise<void>;
  readonly #listeners = new Set<(viewModel: TuiViewModel) => void>();
  #local: InteractiveLocalState;
  #projection: CodingProjection | undefined;
  #run: CodingRunHandle | undefined;
  #iterator: AsyncIterator<import("../../app/coding-events.js").CodingEvent> | undefined;
  #subscriptionGeneration = 0;
  #subscriptionTask: Promise<void> | undefined;
  #startPromise: Promise<TuiViewModel> | undefined;
  #dispatchTail: Promise<void> = Promise.resolve();
  #disposed = false;
  #commandSequence = 0;
  #diagnosticSequence = 0;
  #listenerFailureCount = 0;
  #projectionResyncCount = 0;
  #intentFailureCount = 0;

  constructor(options: InteractiveControllerOptions) {
    this.#session = options.session;
    this.#createCommandId =
      options.createCommandId ?? (() => `ui-${String(++this.#commandSequence).padStart(6, "0")}`);
    this.#onQuit = options.onQuit ?? (() => {});
    this.#local = createInteractiveLocalState(options);
  }

  start(): Promise<TuiViewModel> {
    if (this.#disposed) return Promise.reject(new Error("InteractiveController 已 dispose"));
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#initialize();
    return this.#startPromise;
  }

  async #initialize(): Promise<TuiViewModel> {
    const active = this.#session.activeRun();
    if (active) await this.#attachRun(active, false);
    else this.#replaceProjection(reduceProjection(undefined, await this.#session.snapshot()));
    return this.current();
  }

  current(): TuiViewModel {
    if (!this.#projection) throw new Error("InteractiveController 尚未 start");
    return selectTuiViewModel(this.#projection, this.#local);
  }

  subscribe(listener: (viewModel: TuiViewModel) => void): () => void {
    if (this.#disposed) throw new Error("InteractiveController 已 dispose");
    this.#listeners.add(listener);
    if (this.#projection) this.#notifyOne(listener, this.current());
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  dispatch(intent: UiIntent): Promise<UiIntentResult> {
    const result = this.#dispatchTail.then(() => this.#applyIntent(intent));
    this.#dispatchTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async #applyIntent(intent: UiIntent): Promise<UiIntentResult> {
    if (this.#disposed) return this.#rejected(intent, "InteractiveController 已 dispose");
    if (!this.#projection) return this.#rejected(intent, "InteractiveController 尚未 start");
    try {
      if (isLocalIntent(intent)) {
        const previous = this.#local;
        this.#local = reduceInteractiveLocalState(previous, intent);
        if (this.#local === previous) return this.#unchanged(intent);
        this.#emit();
        return this.#applied(intent);
      }
      return await this.#applyApplicationIntent(intent);
    } catch (cause) {
      this.#intentFailureCount += 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      this.#appendDiagnostic({
        id: `controller:intent:${++this.#diagnosticSequence}`,
        source: "controller",
        severity: "error",
        code: "UI_INTENT_FAILED",
        message,
        recoverable: true,
      });
      return this.#rejected(intent, message);
    }
  }

  async #applyApplicationIntent(intent: UiApplicationIntent): Promise<UiIntentResult> {
    switch (intent.type) {
      case "submit_task": {
        const text = intent.text.trim();
        if (text.length === 0) return this.#rejected(intent, "Coding Task 不能为空");
        if (this.#run && this.#projection?.activeRunId) {
          return this.#rejected(intent, "active Run 期间请显式选择 steering 或 follow-up");
        }
        const selectedModel: ModelRef | undefined = intent.model ?? this.#local.selectedModel;
        const input = {
          task: text,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(intent.acceptWorkspaceFingerprint
            ? { acceptWorkspaceFingerprint: intent.acceptWorkspaceFingerprint }
            : {}),
        };
        const hasHistory = this.#projection !== undefined && this.#projection.runOrder.length > 0;
        const run = hasHistory
          ? await this.#session.resume(input)
          : await this.#session.startRun(input);
        this.#local = reduceInteractiveLocalState(this.#local, {
          version: 1,
          type: "composer_changed",
          value: "",
        });
        await this.#attachRun(run, false);
        return this.#applied(intent);
      }
      case "send_run_message": {
        const text = intent.text.trim();
        if (text.length === 0) return this.#rejected(intent, "queue message 不能为空");
        const run = this.#requireActiveRun();
        const ack = await run.dispatch({
          commandId: this.#createCommandId(),
          type: intent.delivery === "steering" ? "steer" : "follow_up",
          text,
        });
        return this.#fromAck(intent, ack);
      }
      case "respond_approval": {
        const run = this.#requireActiveRun();
        const ack = await run.dispatch({
          commandId: this.#createCommandId(),
          type: "respond_permission",
          approvalId: intent.approvalId,
          decision: intent.decision,
          planFingerprint: intent.planFingerprint,
        });
        return this.#fromAck(intent, ack);
      }
      case "update_queue": {
        const run = this.#requireActiveRun();
        const ack = await run.dispatch({
          commandId: this.#createCommandId(),
          type: "update_queue",
          targetCommandId: intent.targetCommandId,
          expectedRevision: intent.expectedRevision,
          status: intent.status,
          ...(intent.text !== undefined ? { text: intent.text } : {}),
        });
        return this.#fromAck(intent, ack);
      }
      case "abort_run": {
        const run = this.#requireActiveRun();
        const ack = await run.dispatch({
          commandId: this.#createCommandId(),
          type: "abort",
          ...(intent.reason ? { reason: intent.reason } : {}),
        });
        return this.#fromAck(intent, ack);
      }
      case "select_branch":
        await this.#session.selectBranch({
          branchId: intent.branchId,
          expectedRevision: intent.expectedRevision,
        });
        await this.#detachRun();
        this.#replaceProjection(reduceProjection(undefined, await this.#session.snapshot()));
        return this.#applied(intent);
      case "fork_branch":
        await this.#session.fork({
          fromBranchId: intent.fromBranchId,
          expectedRevision: intent.expectedRevision,
        });
        this.#replaceProjection(reduceProjection(undefined, await this.#session.snapshot()));
        return this.#applied(intent);
      case "quit":
        await this.#onQuit();
        return this.#applied(intent);
    }
  }

  #requireActiveRun(): CodingRunHandle {
    if (!this.#run || !this.#projection?.activeRunId) throw new Error("当前没有 active Run");
    return this.#run;
  }

  async #attachRun(run: CodingRunHandle, resync: boolean): Promise<void> {
    await this.#detachRun();
    this.#run = run;
    const joined = await run.snapshot();
    this.#replaceProjection(reduceProjection(undefined, joined.snapshot));
    if (resync) this.#projectionResyncCount += 1;
    const generation = ++this.#subscriptionGeneration;
    const iterator = run.events(joined.cursor)[Symbol.asyncIterator]();
    this.#iterator = iterator;
    this.#subscriptionTask = this.#pumpEvents(run, iterator, generation);
  }

  async #pumpEvents(
    run: CodingRunHandle,
    iterator: AsyncIterator<import("../../app/coding-events.js").CodingEvent>,
    generation: number,
  ): Promise<void> {
    try {
      while (!this.#disposed && generation === this.#subscriptionGeneration) {
        const result = await iterator.next();
        if (result.done || generation !== this.#subscriptionGeneration) return;
        const previousTranscriptLength = this.#projection?.transcript.length ?? 0;
        const next = reduceProjection(this.#projection, result.value);
        if (next.requiresSnapshot) {
          await this.#attachRun(run, true);
          return;
        }
        this.#projection = next;
        const growth = Math.max(0, next.transcript.length - previousTranscriptLength);
        this.#local = observeTranscriptGrowth(this.#local, growth);
        this.#emit();
        if (result.value.category === "semantic" && result.value.type === "terminal_committed") {
          this.#run = undefined;
        }
      }
    } catch (cause) {
      if (this.#disposed || generation !== this.#subscriptionGeneration) return;
      this.#appendDiagnostic({
        id: `controller:event-stream:${++this.#diagnosticSequence}`,
        source: "controller",
        severity: "error",
        code: "EVENT_STREAM_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        recoverable: true,
      });
    }
  }

  async #detachRun(): Promise<void> {
    this.#subscriptionGeneration += 1;
    const iterator = this.#iterator;
    this.#iterator = undefined;
    if (iterator?.return) await iterator.return();
    this.#run = undefined;
  }

  #replaceProjection(projection: CodingProjection): void {
    const previousTranscriptLength =
      this.#projection?.transcript.length ?? projection.transcript.length;
    this.#projection = projection;
    this.#local = observeTranscriptGrowth(
      this.#local,
      Math.max(0, projection.transcript.length - previousTranscriptLength),
    );
    this.#emit();
  }

  #appendDiagnostic(diagnostic: TuiDiagnostic): void {
    this.#local = appendInteractiveDiagnostic(this.#local, diagnostic);
    if (this.#projection) this.#emit();
  }

  #emit(): void {
    const viewModel = this.current();
    for (const listener of this.#listeners) this.#notifyOne(listener, viewModel);
  }

  #notifyOne(listener: (viewModel: TuiViewModel) => void, viewModel: TuiViewModel): void {
    try {
      listener(viewModel);
    } catch {
      this.#listenerFailureCount += 1;
    }
  }

  #applied(intent: UiIntent, commandAck?: CodingCommandAck): UiIntentResult {
    return Object.freeze({
      version: 1,
      intentType: intent.type,
      status: "applied",
      ...(commandAck ? { commandAck } : {}),
    });
  }

  #unchanged(intent: UiIntent): UiIntentResult {
    return Object.freeze({ version: 1, intentType: intent.type, status: "unchanged" });
  }

  #rejected(intent: UiIntent, message: string): UiIntentResult {
    return Object.freeze({ version: 1, intentType: intent.type, status: "rejected", message });
  }

  #fromAck(intent: UiIntent, commandAck: CodingCommandAck): UiIntentResult {
    return commandAccepted(commandAck)
      ? this.#applied(intent, commandAck)
      : Object.freeze({
          version: 1,
          intentType: intent.type,
          status: "rejected",
          commandAck,
          message: `application command ${commandAck.status}`,
        });
  }

  diagnostics(): InteractiveControllerDiagnostics {
    return Object.freeze({
      listenerFailureCount: this.#listenerFailureCount,
      projectionResyncCount: this.#projectionResyncCount,
      intentFailureCount: this.#intentFailureCount,
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#detachRun();
    await this.#subscriptionTask?.catch(() => {});
    this.#listeners.clear();
  }
}

export function createInteractiveController(
  options: InteractiveControllerOptions,
): InteractiveController {
  return new ProductionInteractiveController(options);
}
