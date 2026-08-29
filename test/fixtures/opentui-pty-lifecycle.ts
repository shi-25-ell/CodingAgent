import {
  createProductionOpenTuiRenderer,
  InteractiveProcessLifecycle,
  RendererLifecycle,
} from "@coding-agent/coding";
import { CliRenderEvents, TextRenderable } from "@opentui/core";

const mode = process.argv[2] ?? "normal";
const lifecycle = new RendererLifecycle({
  create: () => createProductionOpenTuiRenderer(),
  report(diagnostic) {
    process.stderr.write(`DEX_RENDERER_DIAGNOSTIC ${diagnostic.code}\n`);
  },
});
const processLifecycle = new InteractiveProcessLifecycle({
  stopRenderer: (reason) => lifecycle.stop(reason),
  report(diagnostic) {
    process.stderr.write(`DEX_PROCESS_DIAGNOSTIC ${diagnostic.code}\n`);
  },
});

processLifecycle.install();
const renderer = await lifecycle.start();
const status = new TextRenderable(renderer, {
  id: "pty-status",
  content: `DEX_PTY_READY raw=${process.stdin.isRaw === true} size=${renderer.width}x${renderer.height}`,
});
renderer.root.add(status);
renderer.on(CliRenderEvents.RESIZE, (width: number, height: number) => {
  status.content = `DEX_PTY_RESIZED raw=${process.stdin.isRaw === true} size=${width}x${height}`;
  renderer.requestRender();
});
renderer.requestRender();
await renderer.idle();

if (mode === "normal") {
  await Bun.sleep(500);
  processLifecycle.dispose();
  await lifecycle.stop("normal");
  process.exit(0);
}

if (mode === "fatal") {
  await Bun.sleep(100);
  throw new Error("PTY fatal fixture");
}

await new Promise<never>(() => {});
