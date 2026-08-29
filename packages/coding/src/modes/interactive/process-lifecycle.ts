import type { RendererStopReason } from "./renderer-lifecycle.js";

export type InteractiveProcessSignal = "SIGINT" | "SIGTERM";
export type InteractiveFatalEvent = "uncaughtException" | "unhandledRejection";

export interface InteractiveProcessHost {
  onSignal(signal: InteractiveProcessSignal, listener: () => void): void;
  offSignal(signal: InteractiveProcessSignal, listener: () => void): void;
  onFatal(event: InteractiveFatalEvent, listener: (cause: unknown) => void): void;
  offFatal(event: InteractiveFatalEvent, listener: (cause: unknown) => void): void;
  exit(code: number): void;
}

export interface InteractiveProcessLifecycleDiagnostic {
  readonly code: "UNCAUGHT_EXCEPTION" | "UNHANDLED_REJECTION" | "PROCESS_SHUTDOWN_FAILED";
  readonly message: string;
  readonly cause: unknown;
}

export interface InteractiveProcessLifecycleOptions {
  readonly stopRenderer: (reason: RendererStopReason) => Promise<void>;
  readonly report: (diagnostic: InteractiveProcessLifecycleDiagnostic) => void;
  readonly host?: InteractiveProcessHost;
}

function productionProcessHost(): InteractiveProcessHost {
  // Bun's Process overload set intentionally differs from @types/node. Keep that
  // runtime typing mismatch inside this Adapter instead of leaking it to callers.
  const runtimeProcess = process as unknown as {
    on(event: string, listener: unknown): void;
    off(event: string, listener: unknown): void;
    exit(code: number): never;
  };
  return {
    onSignal: (signal, listener) => runtimeProcess.on(signal, listener),
    offSignal: (signal, listener) => runtimeProcess.off(signal, listener),
    onFatal: (event, listener) => runtimeProcess.on(event, listener),
    offFatal: (event, listener) => runtimeProcess.off(event, listener),
    exit: (code) => runtimeProcess.exit(code),
  };
}

/**
 * Process termination Adapter。它只协调 renderer restore 与 process exit，
 * 不拥有 Run abort、durable Session 或 UI local state。
 */
export class InteractiveProcessLifecycle {
  readonly #stopRenderer: (reason: RendererStopReason) => Promise<void>;
  readonly #report: (diagnostic: InteractiveProcessLifecycleDiagnostic) => void;
  readonly #host: InteractiveProcessHost;
  readonly #signalHandlers: Readonly<Record<InteractiveProcessSignal, () => void>>;
  readonly #fatalHandlers: Readonly<Record<InteractiveFatalEvent, (cause: unknown) => void>>;
  #installed = false;
  #terminating = false;

  constructor(options: InteractiveProcessLifecycleOptions) {
    this.#stopRenderer = options.stopRenderer;
    this.#report = options.report;
    this.#host = options.host ?? productionProcessHost();
    this.#signalHandlers = Object.freeze({
      SIGINT: () => void this.#terminate("signal", 130),
      SIGTERM: () => void this.#terminate("signal", 143),
    });
    this.#fatalHandlers = Object.freeze({
      uncaughtException: (cause) =>
        void this.#terminate("fatal_error", 1, {
          code: "UNCAUGHT_EXCEPTION",
          message: "Dex Code 遇到未捕获异常，正在恢复 terminal。",
          cause,
        }),
      unhandledRejection: (cause) =>
        void this.#terminate("fatal_error", 1, {
          code: "UNHANDLED_REJECTION",
          message: "Dex Code 遇到未处理 Promise rejection，正在恢复 terminal。",
          cause,
        }),
    });
  }

  install(): void {
    if (this.#installed || this.#terminating) return;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      this.#host.onSignal(signal, this.#signalHandlers[signal]);
    }
    for (const event of ["uncaughtException", "unhandledRejection"] as const) {
      this.#host.onFatal(event, this.#fatalHandlers[event]);
    }
    this.#installed = true;
  }

  dispose(): void {
    if (!this.#installed) return;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      this.#host.offSignal(signal, this.#signalHandlers[signal]);
    }
    for (const event of ["uncaughtException", "unhandledRejection"] as const) {
      this.#host.offFatal(event, this.#fatalHandlers[event]);
    }
    this.#installed = false;
  }

  async #terminate(
    reason: RendererStopReason,
    exitCode: number,
    fatal?: InteractiveProcessLifecycleDiagnostic,
  ): Promise<void> {
    if (this.#terminating) return;
    this.#terminating = true;
    this.dispose();
    if (fatal) this.#report(fatal);
    try {
      await this.#stopRenderer(reason);
    } catch (cause) {
      this.#report({
        code: "PROCESS_SHUTDOWN_FAILED",
        message: "renderer shutdown 未完成；terminal 可能需要执行 reset。",
        cause,
      });
    } finally {
      this.#host.exit(exitCode);
    }
  }
}
