import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import {
  type ApprovalPromptPresentation,
  resolveInteractiveTheme,
  resolveOpenTuiTheme,
} from "../../src/modes/interactive/index.js";
import { OpenTuiApprovalPrompt } from "../../src/modes/interactive/opentui-approval-prompt.jsx";

const prompt: ApprovalPromptPresentation = {
  approvalId: "approval-frame",
  title: "Permission required",
  toolName: "shell",
  risks: ["启动 foreground process"],
  resources: ["command: bun test"],
  effects: ["process"],
  fingerprint: "abcdef0123456789",
  selectedDecision: "allow_once",
  fullscreen: false,
  placement: "bottom",
  maxRows: 15,
  pendingCount: 2,
};

describe("OpenTUI V5-A approval prompt", () => {
  it("bottom blocking frame 展示 risk/scope/count，并由 Escape 显式 Deny", async () => {
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    const responses: string[] = [];
    const setup = await testRender(
      () => (
        <OpenTuiApprovalPrompt
          prompt={prompt}
          theme={theme}
          onSelect={() => {}}
          onRespond={(decision) => responses.push(decision)}
          onToggleFullscreen={() => {}}
        />
      ),
      { width: 80, height: 18, useThread: false, kittyKeyboard: true },
    );
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Permission required");
      expect(frame).toContain("2 pending");
      expect(frame).toContain("Risk: 启动 foreground process");
      expect(frame).toContain("command: bun test");
      expect(frame).toContain("Effects: process");
      expect(frame).toContain("Allow once");
      expect(frame).toContain("Deny");

      setup.mockInput.pressEscape();
      await setup.flush({ maxPasses: 10 });
      expect(responses).toEqual(["deny"]);
    } finally {
      setup.renderer.destroy();
    }
  });
});
