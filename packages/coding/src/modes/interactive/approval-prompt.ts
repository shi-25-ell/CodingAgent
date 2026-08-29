import type { CodingApprovalSummary } from "../../app/coding-events.js";
import type {
  ApprovalPromptLocalState,
  TerminalDimensions,
  UiApplicationIntent,
} from "./contracts.js";

export type ApprovalPromptKeyAction =
  | { readonly type: "select"; readonly decision: "allow_once" | "deny" }
  | { readonly type: "respond"; readonly decision: "allow_once" | "deny" }
  | { readonly type: "toggle_fullscreen" }
  | { readonly type: "none" };

export interface ApprovalPromptPresentation {
  readonly approvalId: string;
  readonly title: "Permission required";
  readonly toolName: string;
  readonly risks: readonly string[];
  readonly resources: readonly string[];
  readonly effects: readonly string[];
  readonly fingerprint: string;
  readonly selectedDecision: "allow_once" | "deny";
  readonly fullscreen: boolean;
  readonly placement: "bottom" | "fullscreen";
  readonly maxRows: number;
  readonly pendingCount: number;
}

export function selectApprovalPromptPresentation(
  approval: CodingApprovalSummary,
  state: ApprovalPromptLocalState,
  terminal: TerminalDimensions,
  pendingCount: number,
): ApprovalPromptPresentation {
  if (approval.approvalId !== state.approvalId) {
    throw new Error("approval presentation 与 local state identity 不匹配");
  }
  if (!approval.plan.fingerprint) throw new Error("pending approval 缺少 plan fingerprint");
  if (!Number.isInteger(pendingCount) || pendingCount < 1) {
    throw new RangeError("pendingCount 必须是正整数");
  }
  return Object.freeze({
    approvalId: approval.approvalId,
    title: "Permission required",
    toolName: approval.plan.toolName,
    risks: Object.freeze([...approval.plan.risks]),
    resources: Object.freeze(
      approval.plan.resources.map((resource) => `${resource.kind}: ${resource.value}`),
    ),
    effects: Object.freeze([...approval.plan.effects]),
    fingerprint: approval.plan.fingerprint,
    selectedDecision: state.selectedDecision,
    fullscreen: state.fullscreen,
    placement: state.fullscreen ? "fullscreen" : "bottom",
    maxRows: state.fullscreen ? Math.max(1, terminal.height) : Math.min(15, terminal.height),
    pendingCount,
  });
}

export function resolveApprovalPromptKey(input: {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly selectedDecision: "allow_once" | "deny";
}): ApprovalPromptKeyAction {
  if (input.ctrl && input.name === "f") return { type: "toggle_fullscreen" };
  if (input.name === "escape") return { type: "respond", decision: "deny" };
  if (input.name === "return" || input.name === "kpenter") {
    return { type: "respond", decision: input.selectedDecision };
  }
  if (input.name === "left" || input.name === "h") {
    return { type: "select", decision: "allow_once" };
  }
  if (input.name === "right" || input.name === "l") {
    return { type: "select", decision: "deny" };
  }
  return { type: "none" };
}

export function createApprovalResponseIntent(
  approval: CodingApprovalSummary,
  decision: "allow_once" | "deny",
): UiApplicationIntent {
  const fingerprint = approval.plan.fingerprint;
  if (!fingerprint) throw new Error("pending approval 缺少 plan fingerprint");
  return Object.freeze({
    version: 1,
    type: "respond_approval",
    approvalId: approval.approvalId,
    decision,
    planFingerprint: fingerprint,
  });
}
