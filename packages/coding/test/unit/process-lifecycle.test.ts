import { describe, expect, it } from "bun:test";
import {
  type InteractiveFatalEvent,
  type InteractiveProcessHost,
  InteractiveProcessLifecycle,
  type InteractiveProcessLifecycleDiagnostic,
  type InteractiveProcessSignal,
} from "../../src/modes/interactive/index.js";

class FakeProcessHost implements InteractiveProcessHost {
  readonly signals = new Map<InteractiveProcessSignal, Set<() => void>>();
  readonly fatals = new Map<InteractiveFatalEvent, Set<(cause: unknown) => void>>();
  readonly exits: number[] = [];

  onSignal(signal: InteractiveProcessSignal, listener: () => void): void {
    const listeners = this.signals.get(signal) ?? new Set();
    listeners.add(listener);
    this.signals.set(signal, listeners);
  }

  offSignal(signal: InteractiveProcessSignal, listener: () => void): void {
    this.signals.get(signal)?.delete(listener);
  }

  onFatal(event: InteractiveFatalEvent, listener: (cause: unknown) => void): void {
    const listeners = this.fatals.get(event) ?? new Set();
    listeners.add(listener);
    this.fatals.set(event, listeners);
  }

  offFatal(event: InteractiveFatalEvent, listener: (cause: unknown) => void): void {
    this.fatals.get(event)?.delete(listener);
  }

  exit(code: number): void {
    this.exits.push(code);
  }

  emitSignal(signal: InteractiveProcessSignal): void {
    for (const listener of this.signals.get(signal) ?? []) listener();
  }

  emitFatal(event: InteractiveFatalEvent, cause: unknown): void {
    for (const listener of this.fatals.get(event) ?? []) listener(cause);
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("process lifecycle 未收敛");
}

describe("interactive process lifecycle", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("%s 先 restore renderer，再使用约定 exit code", async (signal, exitCode) => {
    const host = new FakeProcessHost();
    const order: string[] = [];
    const lifecycle = new InteractiveProcessLifecycle({
      host,
      async stopRenderer(reason) {
        expect(reason).toBe("signal");
        order.push("restore");
      },
      report() {},
    });
    lifecycle.install();

    host.emitSignal(signal);
    await until(() => host.exits.length === 1);
    order.push(`exit:${host.exits[0]}`);

    expect(order).toEqual(["restore", `exit:${exitCode}`]);
    expect(host.signals.get(signal)?.size).toBe(0);
    expect(host.fatals.get("uncaughtException")?.size).toBe(0);
  });

  it.each([
    ["uncaughtException", "UNCAUGHT_EXCEPTION"],
    ["unhandledRejection", "UNHANDLED_REJECTION"],
  ] as const)("%s 保留 fatal diagnostic 并 restore", async (event, code) => {
    const host = new FakeProcessHost();
    const failure = new Error(event);
    const diagnostics: InteractiveProcessLifecycleDiagnostic[] = [];
    const stopReasons: string[] = [];
    const lifecycle = new InteractiveProcessLifecycle({
      host,
      async stopRenderer(reason) {
        stopReasons.push(reason);
      },
      report: (diagnostic) => diagnostics.push(diagnostic),
    });
    lifecycle.install();

    host.emitFatal(event, failure);
    await until(() => host.exits.length === 1);

    expect(stopReasons).toEqual(["fatal_error"]);
    expect(diagnostics).toEqual([expect.objectContaining({ code, cause: failure })]);
    expect(host.exits).toEqual([1]);
  });

  it("并发 termination event 只触发一次 restore/exit", async () => {
    const host = new FakeProcessHost();
    let restoreCount = 0;
    const lifecycle = new InteractiveProcessLifecycle({
      host,
      async stopRenderer() {
        restoreCount += 1;
        await Promise.resolve();
      },
      report() {},
    });
    lifecycle.install();

    host.emitSignal("SIGINT");
    host.emitSignal("SIGTERM");
    await until(() => host.exits.length === 1);

    expect(restoreCount).toBe(1);
    expect(host.exits).toEqual([130]);
  });

  it("restore rejection 仍输出最小 diagnostic 并退出", async () => {
    const host = new FakeProcessHost();
    const diagnostics: InteractiveProcessLifecycleDiagnostic[] = [];
    const lifecycle = new InteractiveProcessLifecycle({
      host,
      stopRenderer: () => Promise.reject(new Error("destroy rejected")),
      report: (diagnostic) => diagnostics.push(diagnostic),
    });
    lifecycle.install();

    host.emitSignal("SIGTERM");
    await until(() => host.exits.length === 1);

    expect(diagnostics).toEqual([expect.objectContaining({ code: "PROCESS_SHUTDOWN_FAILED" })]);
    expect(host.exits).toEqual([143]);
  });
});
