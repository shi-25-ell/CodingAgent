import { describe, expect, it } from "bun:test";
import type { CodingApprovalSummary } from "../../src/app/coding-events.js";
import {
  createApprovalResponseIntent,
  resolveApprovalPromptKey,
  selectApprovalPromptPresentation,
} from "../../src/modes/interactive/index.js";

const approval: CodingApprovalSummary = {
  approvalId: "approval-1",
  callId: "call-1",
  decisions: ["allow_once", "deny"],
  status: "pending",
  plan: {
    callId: "call-1",
    toolName: "shell",
    resources: [{ kind: "command", value: "bun test" }],
    effects: ["process"],
    risks: ["启动 workspace-scoped foreground process"],
    fingerprint: "abcdef0123456789",
  },
};

describe("V5-A approval prompt policy", () => {
  it("bottom prompt 默认 Allow once、最多 15 行，并保留完整 redacted plan metadata", () => {
    expect(
      selectApprovalPromptPresentation(
        approval,
        {
          approvalId: approval.approvalId,
          selectedDecision: "allow_once",
          fullscreen: false,
          returnFocus: "composer",
        },
        { width: 80, height: 24 },
        2,
      ),
    ).toEqual({
      approvalId: "approval-1",
      title: "Permission required",
      toolName: "shell",
      risks: ["启动 workspace-scoped foreground process"],
      resources: ["command: bun test"],
      effects: ["process"],
      fingerprint: "abcdef0123456789",
      selectedDecision: "allow_once",
      fullscreen: false,
      placement: "bottom",
      maxRows: 15,
      pendingCount: 2,
    });
  });

  it("Escape 只映射 Deny；abort 不属于 approval local key action", () => {
    expect(resolveApprovalPromptKey({ name: "escape", selectedDecision: "allow_once" })).toEqual({
      type: "respond",
      decision: "deny",
    });
    expect(resolveApprovalPromptKey({ name: "return", selectedDecision: "allow_once" })).toEqual({
      type: "respond",
      decision: "allow_once",
    });
    expect(resolveApprovalPromptKey({ name: "f", ctrl: true, selectedDecision: "deny" })).toEqual({
      type: "toggle_fullscreen",
    });
    expect(resolveApprovalPromptKey({ name: "a", ctrl: true, selectedDecision: "deny" })).toEqual({
      type: "none",
    });
  });

  it("response intent 携带 approval identity 与 exact plan fingerprint", () => {
    expect(createApprovalResponseIntent(approval, "deny")).toEqual({
      version: 1,
      type: "respond_approval",
      approvalId: "approval-1",
      decision: "deny",
      planFingerprint: "abcdef0123456789",
    });
  });
});
