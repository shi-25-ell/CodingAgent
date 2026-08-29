import { describe, expect, it } from "bun:test";
import { branchId, runId, sessionId } from "@coding-agent/agent";
import { createTestRenderer } from "@opentui/core/testing";
import type {
  InteractiveController,
  UiIntent,
  UiIntentResult,
} from "../../src/modes/interactive/index.js";
import { mountOpenTuiSessionComposition } from "../../src/modes/interactive/opentui-session-composition.jsx";
import type { CodingSessionSnapshot, TuiViewModel } from "../../src/projection/contracts.js";
import { reduceProjection, selectTuiViewModel } from "../../src/projection/projection.js";

const run = runId("run-session-frame");
const snapshot: CodingSessionSnapshot = {
  version: 1,
  ref: { sessionId: sessionId("session-frame") },
  workspace: { root: "D:/workspace", fingerprint: "frame:1" },
  revision: 1,
  currentBranchId: branchId("branch-main"),
  branches: [{ branchId: branchId("branch-main"), recordCount: 2 }],
  runOrder: [],
  runs: {},
  transcript: [
    { id: "user:1", runId: run, ledgerSeq: 1, kind: "user", text: "检查当前实现" },
    {
      id: "assistant:2",
      runId: run,
      ledgerSeq: 2,
      kind: "assistant",
      assistant: {
        role: "assistant",
        content: [{ type: "text", text: "已完成 **foundation**。" }],
        finishReason: "stop",
      },
    },
  ],
  queues: [],
};

function initialViewModel(): TuiViewModel {
  return selectTuiViewModel(reduceProjection(undefined, snapshot), {
    focusedRegion: "composer",
    terminal: { width: 80, height: 18 },
    composer: { value: "", revision: 0, deliveryMode: "steering" },
    sidebar: { preference: "auto", open: false },
  });
}

class FrameController implements InteractiveController {
  readonly intents: UiIntent[] = [];
  readonly listeners = new Set<(viewModel: TuiViewModel) => void>();
  viewModel = initialViewModel();

  async start(): Promise<TuiViewModel> {
    return this.viewModel;
  }

  current(): TuiViewModel {
    return this.viewModel;
  }

  subscribe(listener: (viewModel: TuiViewModel) => void): () => void {
    this.listeners.add(listener);
    listener(this.viewModel);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispatch(intent: UiIntent): Promise<UiIntentResult> {
    this.intents.push(intent);
    let ui = this.viewModel.ui;
    if (intent.type === "composer_changed") {
      ui = {
        ...ui,
        composer: {
          ...ui.composer,
          value: intent.value,
          revision: ui.composer.revision + 1,
        },
      };
    }
    if (intent.type === "open_surface") {
      ui = { ...ui, surfaceStack: [...ui.surfaceStack, intent.surface] };
    }
    if (intent.type === "close_surface") {
      const index = intent.kind
        ? ui.surfaceStack.findLastIndex((surface) => surface.kind === intent.kind)
        : ui.surfaceStack.length - 1;
      if (index >= 0) {
        ui = {
          ...ui,
          surfaceStack: [...ui.surfaceStack.slice(0, index), ...ui.surfaceStack.slice(index + 1)],
        };
      }
    }
    if (intent.type === "terminal_resized") {
      ui = { ...ui, terminal: { width: intent.width, height: intent.height } };
    }
    if (intent.type === "focus_region") ui = { ...ui, focusedRegion: intent.region };
    if (intent.type === "report_diagnostic") {
      this.viewModel = {
        ...this.viewModel,
        diagnostics: [...this.viewModel.diagnostics, intent.diagnostic],
        ui,
      };
    } else {
      this.viewModel = { ...this.viewModel, ui };
    }
    for (const listener of this.listeners) listener(this.viewModel);
    return { version: 1, intentType: intent.type, status: "applied" };
  }

  diagnostics() {
    return { listenerFailureCount: 0, projectionResyncCount: 0, intentFailureCount: 0 };
  }

  async dispose(): Promise<void> {}
}

describe("OpenTUI production Session composition", () => {
  it("从 TuiViewModel 渲染 stretch Transcript/Composer，并只发出 UiIntent", async () => {
    const setup = await createTestRenderer({
      width: 80,
      height: 18,
      useThread: false,
      kittyKeyboard: true,
    });
    const controller = new FrameController();
    const composition = await mountOpenTuiSessionComposition({
      renderer: setup.renderer,
      controller,
      themeMode: "dark",
    });
    try {
      await setup.renderOnce();
      await setup.flush({ maxPasses: 20 });
      const initial = setup.captureCharFrame();
      expect(initial).toContain("Dex Code");
      expect(initial).toContain("检查当前实现");
      expect(initial).toContain("foundation");
      expect(initial).toContain("TASK");
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("composer");

      setup.mockInput.pressKey("p", { ctrl: true });
      await setup.flush({ maxPasses: 20 });
      expect(setup.captureCharFrame()).toContain("command palette");
      expect(controller.intents).toContainEqual({
        version: 1,
        type: "open_surface",
        surface: { kind: "command_palette" },
      });

      setup.mockInput.pressEscape();
      await setup.flush({ maxPasses: 20 });
      expect(setup.captureCharFrame()).not.toContain("command palette");

      await setup.mockInput.typeText("继续");
      setup.mockInput.pressEnter();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.intents.some((intent) => intent.type === "composer_changed")).toBe(true);
      expect(controller.intents.some((intent) => intent.type === "submit_composer")).toBe(true);

      setup.resize(140, 24);
      await setup.flush({ maxPasses: 20 });
      expect(controller.current().ui.terminal).toEqual({ width: 140, height: 24 });
      expect(setup.captureCharFrame()).toContain("Modified Files");
      expect(controller.intents.every((intent) => intent.version === 1)).toBe(true);
    } finally {
      await composition.dispose();
      setup.renderer.destroy();
    }
  });
});
