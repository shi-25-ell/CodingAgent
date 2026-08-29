import { describe, expect, it } from "bun:test";
import {
  RendererLifecycle,
  type RendererLifecycleDiagnostic,
} from "../../src/modes/interactive/index.js";

class FakeRenderer {
  destroyCount = 0;
  isDestroyed = false;
  destroyError: Error | undefined;

  destroy(): void {
    this.destroyCount += 1;
    if (this.destroyError) throw this.destroyError;
    this.isDestroyed = true;
  }
}

describe("renderer lifecycle", () => {
  it("start/stop 对 renderer acquire 与 terminal restore 都幂等", async () => {
    const renderer = new FakeRenderer();
    let createCount = 0;
    const diagnostics: RendererLifecycleDiagnostic[] = [];
    const lifecycle = new RendererLifecycle({
      async create() {
        createCount += 1;
        return renderer;
      },
      report: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(await lifecycle.start()).toBe(renderer);
    expect(await lifecycle.start()).toBe(renderer);
    const firstStop = lifecycle.stop("quit");
    const secondStop = lifecycle.stop("normal");
    expect(secondStop).toBe(firstStop);
    await firstStop;

    expect(createCount).toBe(1);
    expect(renderer.destroyCount).toBe(1);
    expect(diagnostics).toEqual([]);
    expect(lifecycle.snapshot()).toEqual({
      state: "stopped",
      stopReason: "quit",
      restoreAttempted: true,
      restoreSucceeded: true,
    });
  });

  it("stop during startup 等待 acquire 后只 restore 一次", async () => {
    const renderer = new FakeRenderer();
    let release: ((renderer: FakeRenderer) => void) | undefined;
    const lifecycle = new RendererLifecycle({
      create: () =>
        new Promise<FakeRenderer>((resolve) => {
          release = resolve;
        }),
      report() {},
    });

    const starting = lifecycle.start();
    const stopping = lifecycle.stop("signal");
    release?.(renderer);
    expect(await starting).toBe(renderer);
    await stopping;

    expect(renderer.destroyCount).toBe(1);
    expect(lifecycle.snapshot().stopReason).toBe("signal");
  });

  it("startup failure 保留 typed diagnostic，不伪造 restore success", async () => {
    const failure = new Error("native load failed");
    const diagnostics: RendererLifecycleDiagnostic[] = [];
    const lifecycle = new RendererLifecycle<FakeRenderer>({
      create: () => Promise.reject(failure),
      report: (diagnostic) => diagnostics.push(diagnostic),
    });

    await expect(lifecycle.start()).rejects.toBe(failure);
    expect(lifecycle.snapshot()).toEqual({
      state: "failed",
      stopReason: "startup_failure",
      restoreAttempted: false,
    });
    expect(diagnostics).toEqual([
      {
        code: "RENDERER_START_FAILED",
        message: "OpenTUI renderer 启动失败；terminal restore 已由 renderer factory 负责。",
        cause: failure,
      },
    ]);
  });

  it("destroy failure 输出最小 diagnostic，同时收束 lifecycle", async () => {
    const renderer = new FakeRenderer();
    renderer.destroyError = new Error("restore failed");
    const diagnostics: RendererLifecycleDiagnostic[] = [];
    const lifecycle = new RendererLifecycle({
      create: async () => renderer,
      report: (diagnostic) => diagnostics.push(diagnostic),
    });

    await lifecycle.start();
    await lifecycle.stop("fatal_error");

    expect(renderer.destroyCount).toBe(1);
    expect(lifecycle.snapshot()).toEqual({
      state: "stopped",
      stopReason: "fatal_error",
      restoreAttempted: true,
      restoreSucceeded: false,
    });
    expect(diagnostics[0]).toMatchObject({ code: "TERMINAL_RESTORE_FAILED" });
  });

  it("run 在 normal/fatal path 都先 restore terminal", async () => {
    const successfulRenderer = new FakeRenderer();
    const successful = new RendererLifecycle({
      create: async () => successfulRenderer,
      report() {},
    });
    await expect(successful.run(async () => "done")).resolves.toBe("done");
    expect(successfulRenderer.destroyCount).toBe(1);

    const failedRenderer = new FakeRenderer();
    const failed = new RendererLifecycle({
      create: async () => failedRenderer,
      report() {},
    });
    await expect(
      failed.run(async () => {
        throw new Error("render failed");
      }),
    ).rejects.toThrow("render failed");
    expect(failedRenderer.destroyCount).toBe(1);
    expect(failed.snapshot().stopReason).toBe("fatal_error");
  });
});
