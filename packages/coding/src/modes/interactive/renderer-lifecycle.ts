export type RendererLifecycleState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type RendererStopReason =
  | "normal"
  | "quit"
  | "abort"
  | "signal"
  | "fatal_error"
  | "startup_failure";

export interface RendererResource {
  readonly isDestroyed?: boolean;
  destroy(): void;
}

export interface RendererLifecycleDiagnostic {
  readonly code: "RENDERER_START_FAILED" | "TERMINAL_RESTORE_FAILED";
  readonly message: string;
  readonly cause: unknown;
}

export interface RendererLifecycleOptions<TRenderer extends RendererResource> {
  readonly create: () => Promise<TRenderer>;
  readonly report: (diagnostic: RendererLifecycleDiagnostic) => void;
}

export interface RendererLifecycleSnapshot {
  readonly state: RendererLifecycleState;
  readonly stopReason?: RendererStopReason;
  readonly restoreAttempted: boolean;
  readonly restoreSucceeded?: boolean;
}

export class RendererLifecycle<TRenderer extends RendererResource> {
  readonly #create: () => Promise<TRenderer>;
  readonly #report: (diagnostic: RendererLifecycleDiagnostic) => void;
  #state: RendererLifecycleState = "idle";
  #renderer: TRenderer | undefined;
  #startPromise: Promise<TRenderer> | undefined;
  #stopPromise: Promise<void> | undefined;
  #stopReason: RendererStopReason | undefined;
  #restoreAttempted = false;
  #restoreSucceeded: boolean | undefined;

  constructor(options: RendererLifecycleOptions<TRenderer>) {
    this.#create = options.create;
    this.#report = options.report;
  }

  snapshot(): RendererLifecycleSnapshot {
    return Object.freeze({
      state: this.#state,
      ...(this.#stopReason ? { stopReason: this.#stopReason } : {}),
      restoreAttempted: this.#restoreAttempted,
      ...(this.#restoreSucceeded === undefined ? {} : { restoreSucceeded: this.#restoreSucceeded }),
    });
  }

  async start(): Promise<TRenderer> {
    if (this.#renderer && this.#state === "running") return this.#renderer;
    if (this.#startPromise) return this.#startPromise;
    if (this.#state === "stopping" || this.#state === "stopped") {
      throw new Error("renderer lifecycle 已停止，不能重新启动");
    }
    this.#state = "starting";
    this.#startPromise = this.#create()
      .then((renderer) => {
        this.#renderer = renderer;
        this.#state = "running";
        return renderer;
      })
      .catch((cause: unknown) => {
        this.#state = "failed";
        this.#stopReason = "startup_failure";
        this.#report({
          code: "RENDERER_START_FAILED",
          message: "OpenTUI renderer 启动失败；terminal restore 已由 renderer factory 负责。",
          cause,
        });
        throw cause;
      });
    return this.#startPromise;
  }

  stop(reason: RendererStopReason): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopReason = reason;
    this.#stopPromise = this.#stopAfterStart();
    return this.#stopPromise;
  }

  async #stopAfterStart(): Promise<void> {
    if (this.#state === "idle") {
      this.#state = "stopped";
      return;
    }
    if (this.#state === "starting") {
      try {
        await this.#startPromise;
      } catch {
        return;
      }
    }
    if (!this.#renderer || this.#state === "failed") return;
    this.#state = "stopping";
    this.#restoreAttempted = true;
    try {
      if (!this.#renderer.isDestroyed) this.#renderer.destroy();
      this.#restoreSucceeded = true;
    } catch (cause) {
      this.#restoreSucceeded = false;
      this.#report({
        code: "TERMINAL_RESTORE_FAILED",
        message: "OpenTUI renderer destroy 失败；terminal 可能需要执行 reset。",
        cause,
      });
    } finally {
      this.#state = "stopped";
    }
  }

  async run<TResult>(work: (renderer: TRenderer) => Promise<TResult>): Promise<TResult> {
    const renderer = await this.start();
    try {
      const result = await work(renderer);
      await this.stop("normal");
      return result;
    } catch (error) {
      await this.stop("fatal_error");
      throw error;
    }
  }
}
