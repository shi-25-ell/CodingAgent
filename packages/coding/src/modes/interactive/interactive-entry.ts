import type { CliRenderer } from "@opentui/core";
import type { InteractionMode, ModeContext, ModeExit } from "../registry.js";
import { createInteractiveController } from "./controller.js";
import { createProductionOpenTuiRenderer } from "./opentui-renderer.js";
import type { OpenTuiSessionComposition } from "./opentui-session-composition.jsx";
import { InteractiveProcessLifecycle } from "./process-lifecycle.js";
import { RendererLifecycle, type RendererLifecycleDiagnostic } from "./renderer-lifecycle.js";

export interface InteractiveEntryDependencies {
  readonly createRenderer?: () => Promise<CliRenderer>;
}

export type InteractiveEntryResult = ModeExit & {
  readonly status: "quit" | "aborted" | "usage_error" | "start_error";
};

function reportCause(context: ModeContext, prefix: string, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  context.io.stderr(`${prefix}: ${message}\n`);
}

/** Production interactive composition root used by the default `dex` command. */
export async function runInteractiveEntry(
  context: ModeContext,
  dependencies: InteractiveEntryDependencies = {},
): Promise<InteractiveEntryResult> {
  if (context.argv.length > 0) {
    context.io.stderr(`interactive mode 不接受参数: ${context.argv.join(" ")}\n`);
    return { exitCode: 2, status: "usage_error" };
  }

  const lifecycle = new RendererLifecycle<CliRenderer>({
    create: dependencies.createRenderer ?? (() => createProductionOpenTuiRenderer()),
    report(diagnostic: RendererLifecycleDiagnostic) {
      reportCause(context, diagnostic.message, diagnostic.cause);
    },
  });
  const processLifecycle = new InteractiveProcessLifecycle({
    stopRenderer: (reason) => lifecycle.stop(reason),
    report(diagnostic) {
      reportCause(context, diagnostic.message, diagnostic.cause);
    },
  });
  let controller: ReturnType<typeof createInteractiveController> | undefined;
  let composition: OpenTuiSessionComposition | undefined;
  let abortListener: (() => void) | undefined;

  try {
    const session =
      context.session ?? (await context.agent.createSession({ workspace: context.workspace }));
    const renderer = await lifecycle.start();
    let settle!: (result: InteractiveEntryResult) => void;
    const finished = new Promise<InteractiveEntryResult>((resolve) => {
      settle = resolve;
    });
    let settled = false;
    const finish = (result: InteractiveEntryResult): void => {
      if (settled) return;
      settled = true;
      settle(result);
    };
    controller = createInteractiveController({
      session,
      agent: context.agent,
      width: renderer.width,
      height: renderer.height,
      onQuit: () => finish({ exitCode: 0, status: "quit" }),
    });
    const { mountOpenTuiSessionComposition } = await import("./opentui-session-composition.jsx");
    composition = await mountOpenTuiSessionComposition({ renderer, controller });
    processLifecycle.install();
    abortListener = () => finish({ exitCode: 130, status: "aborted" });
    if (context.signal.aborted) abortListener();
    else context.signal.addEventListener("abort", abortListener, { once: true });
    return await finished;
  } catch (cause) {
    reportCause(context, "无法启动 Dex Code interactive mode", cause);
    return { exitCode: 1, status: "start_error" };
  } finally {
    if (abortListener) context.signal.removeEventListener("abort", abortListener);
    processLifecycle.dispose();
    await composition?.dispose();
    await controller?.dispose();
    await lifecycle.stop(context.signal.aborted ? "abort" : "quit");
  }
}

export function createInteractiveInteractionMode(
  dependencies: InteractiveEntryDependencies = {},
): InteractionMode {
  return {
    descriptor: { id: "interactive", displayName: "Interactive", interactive: true },
    run: (context) => runInteractiveEntry(context, dependencies),
  };
}
