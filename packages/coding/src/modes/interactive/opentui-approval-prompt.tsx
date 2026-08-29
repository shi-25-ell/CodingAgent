import type { KeyEvent } from "@opentui/core";
import { For, Show } from "solid-js";
import type { ApprovalPromptPresentation } from "./approval-prompt.js";
import { resolveApprovalPromptKey } from "./approval-prompt.js";
import type { OpenTuiTheme } from "./opentui-theme-adapter.js";

export interface OpenTuiApprovalPromptProps {
  readonly prompt: ApprovalPromptPresentation;
  readonly theme: OpenTuiTheme;
  readonly onSelect: (decision: "allow_once" | "deny") => void;
  readonly onRespond: (decision: "allow_once" | "deny") => void;
  readonly onToggleFullscreen: () => void;
}

export function OpenTuiApprovalPrompt(props: OpenTuiApprovalPromptProps) {
  const handleKey = (event: KeyEvent) => {
    const action = resolveApprovalPromptKey({
      name: event.name,
      ctrl: event.ctrl,
      selectedDecision: props.prompt.selectedDecision,
    });
    if (action.type === "none") return;
    event.preventDefault();
    event.stopPropagation();
    if (action.type === "select") props.onSelect(action.decision);
    if (action.type === "respond") props.onRespond(action.decision);
    if (action.type === "toggle_fullscreen") props.onToggleFullscreen();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: terminal dialog owns a keyboard focus scope.
    <box
      id={`approval:${props.prompt.approvalId}`}
      focusable
      focused
      flexDirection="column"
      width="100%"
      maxHeight={props.prompt.maxRows}
      overflow="hidden"
      backgroundColor={props.theme.colors.backgroundPanel}
      border={["left"]}
      borderColor={props.theme.colors.warning}
      padding={1}
      gap={1}
      onKeyDown={handleKey}
      {...(props.prompt.fullscreen
        ? { position: "absolute" as const, top: 0, bottom: 0, left: 0, right: 0, zIndex: 100 }
        : {})}
    >
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={props.theme.colors.warning}>△</text>
        <text fg={props.theme.colors.text}>{props.prompt.title}</text>
        <Show when={props.prompt.pendingCount > 1}>
          <text fg={props.theme.colors.textMuted}>({props.prompt.pendingCount} pending)</text>
        </Show>
      </box>
      <text fg={props.theme.colors.text}>Tool: {props.prompt.toolName}</text>
      <For each={props.prompt.risks}>
        {(risk) => <text fg={props.theme.colors.warning}>Risk: {risk}</text>}
      </For>
      <For each={props.prompt.resources}>
        {(resource) => <text fg={props.theme.colors.textMuted}>{resource}</text>}
      </For>
      <text fg={props.theme.colors.textMuted}>Effects: {props.prompt.effects.join(", ")}</text>
      <text fg={props.theme.colors.textSubtle}>
        Plan: {props.prompt.fingerprint.slice(0, props.prompt.fullscreen ? undefined : 12)}
      </text>
      <box
        flexDirection="row"
        justifyContent="space-between"
        backgroundColor={props.theme.colors.backgroundElement}
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
      >
        <box flexDirection="row" gap={1}>
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={
              props.prompt.selectedDecision === "allow_once"
                ? props.theme.colors.warning
                : props.theme.colors.backgroundMenu
            }
          >
            <text
              fg={
                props.prompt.selectedDecision === "allow_once"
                  ? props.theme.colors.background
                  : props.theme.colors.textMuted
              }
            >
              Allow once
            </text>
          </box>
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={
              props.prompt.selectedDecision === "deny"
                ? props.theme.colors.error
                : props.theme.colors.backgroundMenu
            }
          >
            <text
              fg={
                props.prompt.selectedDecision === "deny"
                  ? props.theme.colors.background
                  : props.theme.colors.textMuted
              }
            >
              Deny
            </text>
          </box>
        </box>
        <text fg={props.theme.colors.textMuted}>←/→ select · enter confirm · esc deny</text>
      </box>
    </box>
  );
}
