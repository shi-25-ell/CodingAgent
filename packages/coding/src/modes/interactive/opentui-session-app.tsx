import type {
  ScrollBoxRenderable,
  SyntaxStyle,
  TextareaOptions,
  TextareaRenderable,
} from "@opentui/core";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
  CodingToolProjection,
  CodingTranscriptBlock,
  TuiViewModel,
  UiSurface,
} from "../../projection/contracts.js";
import {
  createApprovalResponseIntent,
  selectApprovalPromptPresentation,
} from "./approval-prompt.js";
import type { UiIntent } from "./contracts.js";
import { resolveInteractiveLayout } from "./layout-policy.js";
import { OpenTuiApprovalPrompt } from "./opentui-approval-prompt.jsx";
import { bindOpenTuiComposer, createOpenTuiComposerOptions } from "./opentui-composer-adapter.js";
import {
  createOpenTuiCodeOptions,
  createOpenTuiInlineDiffOptions,
  createOpenTuiMarkdownOptions,
} from "./opentui-content-adapters.js";
import type { OpenTuiTheme } from "./opentui-theme-adapter.js";
import { resolveInteractiveSurfacePolicy } from "./surface-policy.js";
import { selectToolPresentation, type ToolPresentationTone } from "./tool-presentation.js";

export interface OpenTuiSessionAppProps {
  readonly viewModel: () => TuiViewModel;
  readonly theme: () => OpenTuiTheme;
  readonly syntaxStyle: () => SyntaxStyle;
  readonly commandPaletteEntries?: () => readonly {
    readonly id: string;
    readonly title: string;
    readonly category: string;
    readonly bindings: readonly string[];
  }[];
  readonly onIntent: (intent: UiIntent) => void | Promise<void>;
}

function assistantText(block: CodingTranscriptBlock): string {
  if (!block.assistant) return block.text ?? "";
  return block.assistant.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function blockText(block: CodingTranscriptBlock): string {
  if (block.kind === "assistant") return assistantText(block);
  if (block.kind === "tool") return block.outcome?.modelContent ?? "Tool settled";
  if (block.kind === "model_failure") return block.failure?.message ?? "Model failure";
  if (block.kind === "terminal") {
    return block.report
      ? `Run ${block.report.status}: ${block.report.terminationReason}`
      : "Run terminal";
  }
  if (block.kind === "recovery") return block.recovery?.message ?? "Recovery observed";
  return block.text ?? "";
}

function blockLabel(block: CodingTranscriptBlock): string {
  if (block.kind === "user") return "You";
  if (block.kind === "assistant") return "Dex";
  if (block.kind === "tool") return "Tool";
  if (block.kind === "terminal") return "Run";
  if (block.kind === "recovery") return "Recovery";
  return "Model";
}

function toneColor(tone: ToolPresentationTone, theme: OpenTuiTheme) {
  if (tone === "success") return theme.colors.success;
  if (tone === "warning") return theme.colors.warning;
  if (tone === "error") return theme.colors.error;
  if (tone === "running") return theme.colors.running;
  return theme.colors.pending;
}

function solidComposerOptions(
  theme: OpenTuiTheme,
  initialValue: string,
): Omit<TextareaOptions, "onSubmit"> {
  const { onSubmit: _coreSubmit, ...options } = createOpenTuiComposerOptions(theme, {
    initialValue,
  });
  return options;
}

function TranscriptBlock(props: {
  readonly block: CodingTranscriptBlock;
  readonly theme: OpenTuiTheme;
  readonly syntaxStyle: SyntaxStyle;
}) {
  const text = () => blockText(props.block);
  return (
    <box
      id={`transcript:${props.block.id}`}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
    >
      <text
        fg={
          props.block.kind === "assistant"
            ? props.theme.colors.primary
            : props.theme.colors.textMuted
        }
      >
        {blockLabel(props.block)}
      </text>
      <Show
        when={props.block.kind === "assistant" && text().length > 0}
        fallback={<text fg={props.theme.colors.text}>{text()}</text>}
      >
        <text fg={props.theme.markdown.text}>{text()}</text>
      </Show>
    </box>
  );
}

function InlineTool(props: {
  readonly tool: CodingToolProjection;
  readonly viewModel: TuiViewModel;
  readonly availableColumns: number;
  readonly theme: OpenTuiTheme;
  readonly syntaxStyle: SyntaxStyle;
}) {
  const presentation = () =>
    selectToolPresentation(props.tool, {
      availableColumns: props.availableColumns,
      showDetails: props.viewModel.ui.toolDisplay.showDetails,
      showGenericOutput: props.viewModel.ui.toolDisplay.showGenericOutput,
      expandedIds: props.viewModel.ui.expandedIds,
    });
  return (
    <Show when={presentation().visible}>
      <box
        id={presentation().id}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        marginBottom={1}
      >
        <box flexDirection="row" gap={1}>
          <text fg={toneColor(presentation().tone, props.theme)}>
            {presentation().status === "running" ? "●" : "•"}
          </text>
          <text fg={props.theme.colors.text}>{presentation().title}</text>
          <Show when={props.tool.progress}>
            <text fg={props.theme.colors.textMuted}>{props.tool.progress}</text>
          </Show>
        </box>
        <Show when={presentation().failureSummary}>
          <text fg={props.theme.colors.error}>{presentation().failureSummary}</text>
        </Show>
        <Show when={presentation().output !== undefined}>
          <code
            {...createOpenTuiCodeOptions(props.theme, props.syntaxStyle, {
              content: presentation().output?.text ?? "",
              streaming: presentation().status === "running",
              wrapMode: "word",
            })}
            width="100%"
          />
        </Show>
        <Show when={presentation().diff !== undefined}>
          <diff
            {...createOpenTuiInlineDiffOptions(
              presentation().diff as NonNullable<ReturnType<typeof presentation>["diff"]>,
              props.theme,
              props.syntaxStyle,
              { availableColumns: props.availableColumns },
            )}
            width="100%"
          />
        </Show>
        <Show when={presentation().code !== undefined}>
          <code
            {...createOpenTuiCodeOptions(props.theme, props.syntaxStyle, {
              content: presentation().code?.content ?? "",
              ...(presentation().code?.filetype
                ? { filetype: presentation().code?.filetype as string }
                : {}),
            })}
            width="100%"
          />
        </Show>
      </box>
    </Show>
  );
}

function Transcript(props: OpenTuiSessionAppProps & { readonly availableColumns: number }) {
  let scrollbox: ScrollBoxRenderable | undefined;
  createEffect(() => {
    const viewport = props.viewModel().ui.transcriptViewport;
    if (!scrollbox) return;
    scrollbox.stickyScroll = viewport.followTail;
    if (!viewport.followTail) scrollbox.scrollTop = viewport.scrollTop;
  });
  return (
    <scrollbox
      ref={(value) => {
        scrollbox = value;
      }}
      id="transcript"
      focusable
      focused={props.viewModel().ui.focusedRegion === "transcript"}
      flexGrow={1}
      minHeight={0}
      width="100%"
      stickyScroll={props.viewModel().ui.transcriptViewport.followTail}
      stickyStart="bottom"
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
      viewportCulling
    >
      <For each={props.viewModel().transcript}>
        {(block) => (
          <TranscriptBlock block={block} theme={props.theme()} syntaxStyle={props.syntaxStyle()} />
        )}
      </For>
      <For each={props.viewModel().tools.filter((tool) => tool.status !== "settled")}>
        {(tool) => (
          <InlineTool
            tool={tool}
            viewModel={props.viewModel()}
            availableColumns={props.availableColumns}
            theme={props.theme()}
            syntaxStyle={props.syntaxStyle()}
          />
        )}
      </For>
      <Show when={Boolean(props.viewModel().activeRun?.assistantStream?.text)}>
        <box id="assistant-stream" flexDirection="column" paddingLeft={1} paddingRight={1}>
          <text fg={props.theme().colors.streaming}>Dex · streaming</text>
          <markdown
            {...createOpenTuiMarkdownOptions(props.theme(), props.syntaxStyle(), {
              content: props.viewModel().activeRun?.assistantStream?.text ?? "",
              streaming: true,
            })}
            width="100%"
          />
        </box>
      </Show>
    </scrollbox>
  );
}

function Composer(props: OpenTuiSessionAppProps & { readonly maxRows: number }) {
  let textarea: TextareaRenderable | undefined;
  let disposeBinding: (() => void) | undefined;
  const [pasteNotice, setPasteNotice] = createSignal<string>();
  onMount(() => {
    if (!textarea) return;
    disposeBinding = bindOpenTuiComposer(textarea, {
      onChanged: (value) => {
        void props.onIntent({ version: 1, type: "composer_changed", value });
      },
      onSubmit: async () => {
        const revision = props.viewModel().ui.composer.revision;
        await props.onIntent({ version: 1, type: "submit_composer", expectedRevision: revision });
      },
      onLargePaste: (paste) => setPasteNotice(paste.placeholder),
    });
  });
  onCleanup(() => disposeBinding?.());
  createEffect(() => {
    const value = props.viewModel().ui.composer.value;
    if (textarea && textarea.plainText !== value) textarea.setText(value);
  });
  return (
    <box id="composer-region" flexDirection="column" flexShrink={0}>
      <textarea
        ref={(value) => {
          textarea = value;
        }}
        id="composer"
        {...solidComposerOptions(props.theme(), props.viewModel().ui.composer.value)}
        focused={props.viewModel().ui.focusedRegion === "composer"}
        width="100%"
        minHeight={1}
        maxHeight={props.maxRows}
      />
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={props.theme().colors.backgroundPanel}
      >
        <text
          fg={
            props.viewModel().activeRun
              ? props.theme().colors.running
              : props.theme().colors.textMuted
          }
        >
          {props.viewModel().activeRun
            ? props.viewModel().ui.composer.deliveryMode === "steering"
              ? "STEER"
              : "FOLLOW-UP"
            : "TASK"}
        </text>
        <text fg={props.theme().colors.textSubtle}>
          {pasteNotice() ?? "enter submit · shift+enter newline · ctrl+p commands"}
        </text>
      </box>
    </box>
  );
}

function Sidebar(props: OpenTuiSessionAppProps & { readonly overlay: boolean }) {
  const context = () => props.viewModel().context;
  return (
    <box
      id="sidebar"
      focusable={props.overlay}
      focused={props.overlay}
      width={42}
      height="100%"
      flexDirection="column"
      padding={1}
      border={["left"]}
      borderColor={props.theme().colors.border}
      backgroundColor={props.theme().colors.backgroundPanel}
      {...(props.overlay
        ? {
            position: "absolute" as const,
            right: 0,
            top: 0,
            bottom: 0,
            zIndex: 70,
          }
        : {})}
    >
      <text fg={props.theme().colors.primary}>Context</text>
      <text fg={props.theme().colors.textMuted}>
        {context()
          ? `${context()?.measurement.inputTokens ?? 0} input tokens`
          : "No prepared context"}
      </text>
      <text fg={props.theme().colors.primary}>Todo</text>
      <text fg={props.theme().colors.textMuted}>No active todo projection</text>
      <text fg={props.theme().colors.primary}>Modified Files</text>
      <For each={props.viewModel().terminalReport?.changedFiles ?? []}>
        {(file) => <text fg={props.theme().colors.textMuted}>{file}</text>}
      </For>
    </box>
  );
}

function surfaceTitle(surface: UiSurface): string {
  return surface.kind.replaceAll("_", " ");
}

function SecondarySurface(props: OpenTuiSessionAppProps & { readonly surface: UiSurface }) {
  const entries = () => props.commandPaletteEntries?.() ?? [];
  return (
    <box
      id={
        props.surface.kind === "diagnostic"
          ? `surface:diagnostic:${props.surface.id}`
          : props.surface.kind === "run_report"
            ? `surface:run_report:${props.surface.runId}`
            : `surface:${props.surface.kind}`
      }
      focusable
      focused
      position="absolute"
      top={2}
      bottom={2}
      left={4}
      right={4}
      zIndex={95}
      flexDirection="column"
      border
      borderColor={props.theme().colors.borderActive}
      backgroundColor={props.theme().colors.backgroundMenu}
      padding={1}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={props.theme().colors.primary}>{surfaceTitle(props.surface)}</text>
        <text fg={props.theme().colors.textMuted}>Esc close</text>
      </box>
      <Show
        when={props.surface.kind === "command_palette" || props.surface.kind === "which_key"}
        fallback={
          <text fg={props.theme().colors.textMuted}>
            Secondary view foundation · content remains application-provided.
          </text>
        }
      >
        <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
          <For each={entries()}>
            {(entry) => (
              <box flexDirection="row" justifyContent="space-between" gap={1}>
                <text fg={props.theme().colors.text}>{entry.title}</text>
                <text fg={props.theme().colors.textMuted}>{entry.bindings.join(" · ")}</text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  );
}

function Approval(props: OpenTuiSessionAppProps) {
  const local = () => props.viewModel().ui.approvalPrompt;
  const approval = () =>
    props.viewModel().approvals.find((item) => item.approvalId === local()?.approvalId);
  const presentation = () => {
    const currentLocal = local();
    const currentApproval = approval();
    return currentLocal && currentApproval
      ? selectApprovalPromptPresentation(
          currentApproval,
          currentLocal,
          props.viewModel().ui.terminal,
          props.viewModel().approvals.filter((item) => item.status === "pending").length,
        )
      : undefined;
  };
  return (
    <Show when={presentation() !== undefined}>
      <OpenTuiApprovalPrompt
        prompt={presentation() as NonNullable<ReturnType<typeof presentation>>}
        theme={props.theme()}
        onSelect={(decision) => {
          void props.onIntent({
            version: 1,
            type: "set_approval_selection",
            approvalId: presentation()?.approvalId ?? "",
            decision,
          });
        }}
        onRespond={(decision) => {
          const current = approval();
          if (current) void props.onIntent(createApprovalResponseIntent(current, decision));
        }}
        onToggleFullscreen={() => {
          void props.onIntent({
            version: 1,
            type: "set_approval_fullscreen",
            approvalId: presentation()?.approvalId ?? "",
            fullscreen: !(presentation()?.fullscreen ?? false),
          });
        }}
      />
    </Show>
  );
}

/** Transcript-first root. It knows presentation contracts, never CodingSession or durable state. */
export function OpenTuiSessionApp(props: OpenTuiSessionAppProps) {
  const layout = () =>
    resolveInteractiveLayout(
      props.viewModel().ui.terminal.width,
      props.viewModel().ui.terminal.height,
      props.viewModel().ui.sidebar,
    );
  const surface = () => resolveInteractiveSurfacePolicy(props.viewModel());
  const topSurface = () => surface().topSurface;
  const activeStatus = () =>
    props.viewModel().activeRun
      ? `${props.viewModel().activeRun?.status} · ${props.viewModel().activeRun?.phase}`
      : (props.viewModel().terminalReport?.status ?? "idle");
  const latestDiagnostic = () => props.viewModel().diagnostics.at(-1);

  return (
    <box
      id="dex-session-root"
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={props.theme().colors.background}
      paddingLeft={layout().horizontalPaddingColumns}
      paddingRight={layout().horizontalPaddingColumns}
    >
      <Show
        when={surface().layer !== "fatal_error"}
        fallback={
          <box
            id="fatal-error"
            focusable
            focused
            width="100%"
            height="100%"
            flexDirection="column"
            justifyContent="center"
            alignItems="center"
            border
            borderColor={props.theme().colors.error}
          >
            <text fg={props.theme().colors.error}>Dex Code cannot continue</text>
            <text fg={props.theme().colors.text}>{latestDiagnostic()?.message}</text>
          </box>
        }
      >
        <Show
          when={!props.viewModel().ui.diffViewer}
          fallback={
            <box
              id="diff-viewer"
              focusable
              focused
              width="100%"
              height="100%"
              flexDirection="column"
              backgroundColor={props.theme().colors.background}
            >
              <box flexDirection="row" justifyContent="space-between">
                <text fg={props.theme().colors.primary}>Diff</text>
                <text fg={props.theme().colors.textMuted}>q/Esc close · ? help</text>
              </box>
              <box flexGrow={1} justifyContent="center" alignItems="center">
                <text fg={props.theme().colors.textMuted}>
                  Waiting for application-provided structured Diff document.
                </text>
              </box>
            </box>
          }
        >
          <box
            id="session-status"
            focusable
            flexDirection="row"
            justifyContent="space-between"
            flexShrink={0}
            height={layout().headerRows}
          >
            <box flexDirection="row" gap={1}>
              <text fg={props.theme().colors.primary}>Dex Code</text>
              <text fg={props.theme().colors.textMuted}>
                {props.viewModel().session.ref.sessionId}
              </text>
            </box>
            <text
              fg={
                props.viewModel().activeRun
                  ? props.theme().colors.running
                  : props.theme().colors.textMuted
              }
            >
              {activeStatus()}
            </text>
          </box>
          <box flexDirection="row" flexGrow={1} minHeight={0}>
            <box flexDirection="column" flexGrow={1} minWidth={1} minHeight={0}>
              <Transcript {...props} availableColumns={layout().mainColumns} />
              <Show when={latestDiagnostic() && layout().statusRows > 0}>
                <box
                  id="diagnostic-region"
                  flexShrink={0}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={props.theme().colors.backgroundElement}
                >
                  <text
                    fg={
                      latestDiagnostic()?.severity === "error"
                        ? props.theme().colors.error
                        : props.theme().colors.warning
                    }
                  >
                    {latestDiagnostic()?.code}: {latestDiagnostic()?.message}
                  </text>
                </box>
              </Show>
              <Show when={!props.viewModel().ui.approvalPrompt} fallback={<Approval {...props} />}>
                <Composer {...props} maxRows={layout().composer.maxRows} />
              </Show>
            </box>
            <Show when={layout().sidebar.placement === "docked"}>
              <Sidebar {...props} overlay={false} />
            </Show>
          </box>
          <Show when={layout().sidebar.placement === "overlay"}>
            <Sidebar {...props} overlay />
          </Show>
        </Show>
        <Show
          when={
            topSurface() !== undefined &&
            topSurface()?.kind !== "approval" &&
            topSurface()?.kind !== "diff"
          }
        >
          <SecondarySurface {...props} surface={topSurface() as UiSurface} />
        </Show>
      </Show>
    </box>
  );
}
