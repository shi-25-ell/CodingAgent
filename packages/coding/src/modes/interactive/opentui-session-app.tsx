// biome-ignore-all lint/a11y/noStaticElementInteractions: OpenTUI terminal elements use focus scopes and keymap semantics, not DOM roles.
import type { QueueItem } from "@coding-agent/agent";
import type {
  KeyEvent,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextareaOptions,
  TextareaRenderable,
} from "@opentui/core";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
  CodingDiffDocument,
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
} from "./opentui-content-adapters.js";
import { OpenTuiDiffViewer } from "./opentui-diff-viewer.jsx";
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
  readonly onCommand?: (commandId: string) => void | Promise<void>;
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
  readonly viewModel: TuiViewModel;
  readonly availableColumns: number;
  readonly theme: OpenTuiTheme;
  readonly syntaxStyle: SyntaxStyle;
}) {
  const text = () => blockText(props.block);
  const tool = () =>
    props.block.kind === "tool"
      ? props.viewModel.tools.find((item) => item.callId === props.block.outcome?.callId)
      : undefined;
  return (
    <Show
      when={!tool()}
      fallback={
        <InlineTool
          tool={tool() as CodingToolProjection}
          viewModel={props.viewModel}
          availableColumns={props.availableColumns}
          theme={props.theme}
          syntaxStyle={props.syntaxStyle}
        />
      }
    >
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
        <Show when={props.block.kind === "assistant" && text().length > 0}>
          <text fg={props.theme.colors.text}>{text()}</text>
        </Show>
        <Show when={props.block.kind !== "assistant"}>
          <text
            fg={
              props.block.kind === "model_failure" || props.block.kind === "recovery"
                ? props.theme.colors.error
                : props.theme.colors.text
            }
          >
            {text()}
          </text>
        </Show>
      </box>
    </Show>
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
          <Show when={props.tool.elapsedMs !== undefined}>
            <text fg={props.theme.colors.textMuted}>
              {((props.tool.elapsedMs ?? 0) / 1000).toFixed(1)}s
            </text>
          </Show>
        </box>
        <Show when={props.viewModel.ui.toolDisplay.showDetails}>
          <For each={props.tool.plan.resources}>
            {(resource) => (
              <text fg={props.theme.colors.textMuted}>
                resource · {resource.kind}:{resource.value}
              </text>
            )}
          </For>
          <Show when={props.tool.plan.effects.length > 0}>
            <text fg={props.theme.colors.textMuted}>
              effects · {props.tool.plan.effects.join(", ")}
            </text>
          </Show>
          <For each={props.tool.plan.risks}>
            {(risk) => <text fg={props.theme.colors.warning}>risk · {risk}</text>}
          </For>
          <Show when={props.tool.outcome}>
            <text fg={props.theme.colors.textMuted}>
              outcome · {props.tool.outcome?.status} · effect {props.tool.outcome?.effectState}
            </text>
            <For each={props.tool.outcome?.artifacts ?? []}>
              {(artifact) => <text fg={props.theme.colors.accent}>artifact · {artifact.id}</text>}
            </For>
          </Show>
        </Show>
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
          <TranscriptBlock
            block={block}
            viewModel={props.viewModel()}
            availableColumns={props.availableColumns}
            theme={props.theme()}
            syntaxStyle={props.syntaxStyle()}
          />
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
          <text fg={props.theme().colors.text}>
            {props.viewModel().activeRun?.assistantStream?.text}
          </text>
        </box>
      </Show>
      <Show when={Boolean(props.viewModel().activeRun?.assistantStream?.reasoning)}>
        <box id="assistant-reasoning" flexDirection="column" paddingLeft={1} paddingRight={1}>
          <text fg={props.theme().colors.accent}>Reasoning · streaming</text>
          <text fg={props.theme().colors.textMuted}>
            {props.viewModel().activeRun?.assistantStream?.reasoning}
          </text>
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
      <text fg={props.theme().colors.primary}>Unfinished Work</text>
      <For
        each={props.viewModel().terminalReport?.unfinishedWork ?? []}
        fallback={<text fg={props.theme().colors.textMuted}>No unfinished work</text>}
      >
        {(item) => <text fg={props.theme().colors.warning}>{item}</text>}
      </For>
      <text fg={props.theme().colors.primary}>Modified Files</text>
      <For each={props.viewModel().terminalReport?.changedFiles ?? []}>
        {(file) => (
          <text fg={props.theme().colors.textMuted}>
            {file.change} · {file.path}
          </text>
        )}
      </For>
    </box>
  );
}

function surfaceTitle(surface: UiSurface): string {
  return surface.kind.replaceAll("_", " ");
}

function QueueEditor(props: OpenTuiSessionAppProps & { readonly item: QueueItem }) {
  let textarea: TextareaRenderable | undefined;
  let disposeBinding: (() => void) | undefined;
  onMount(() => {
    if (!textarea) return;
    disposeBinding = bindOpenTuiComposer(textarea, {
      onChanged: () => {},
      onSubmit: async (text) => {
        await props.onIntent({
          version: 1,
          type: "update_queue",
          targetCommandId: props.item.commandId,
          expectedRevision: props.item.revision,
          text,
          status: "queued",
        });
      },
    });
  });
  onCleanup(() => disposeBinding?.());
  return (
    <box flexDirection="column" paddingLeft={1} marginTop={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={props.theme().colors.text}>
          {props.item.kind} · {props.item.status} · rev {props.item.revision}
        </text>
        <text
          fg={props.theme().colors.warning}
          onMouseUp={() =>
            void props.onIntent({
              version: 1,
              type: "update_queue",
              targetCommandId: props.item.commandId,
              expectedRevision: props.item.revision,
              status: "cancelled",
            })
          }
        >
          cancel
        </text>
      </box>
      <textarea
        ref={(value) => {
          textarea = value;
        }}
        {...solidComposerOptions(props.theme(), props.item.text)}
        width="100%"
        minHeight={1}
        maxHeight={4}
      />
      <text fg={props.theme().colors.textMuted}>Edit text, then Enter to queue/deliver</text>
    </box>
  );
}

function SecondarySurface(props: OpenTuiSessionAppProps & { readonly surface: UiSurface }) {
  const entries = () => props.commandPaletteEntries?.() ?? [];
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const context = () => props.viewModel().context;
  const report = () => {
    const surface = props.surface;
    return surface.kind === "run_report"
      ? props.viewModel().runHistory.find((item) => item.runId === surface.runId)
      : undefined;
  };
  const itemCount = () => {
    if (props.surface.kind === "session_selector")
      return props.viewModel().catalog.sessions.length + 1;
    if (props.surface.kind === "model_selector") return props.viewModel().catalog.models.length;
    if (props.surface.kind === "branch_selector")
      return props.viewModel().session.branches.length + 1;
    if (props.surface.kind === "theme_selector") return 2;
    if (props.surface.kind === "diff_source_selector") return 3;
    if (props.surface.kind === "command_palette") return entries().length;
    return 0;
  };
  const chooseSelected = async () => {
    const index = selectedIndex();
    if (props.surface.kind === "session_selector") {
      const session = props.viewModel().catalog.sessions[index - 1];
      await props.onIntent(
        session
          ? { version: 1, type: "open_session", ref: session.ref }
          : { version: 1, type: "new_session" },
      );
      return;
    }
    if (props.surface.kind === "model_selector") {
      const model = props.viewModel().catalog.models[index];
      if (model)
        await props.onIntent({
          version: 1,
          type: "select_model",
          model: { providerId: model.providerId, modelId: model.modelId },
        });
    } else if (props.surface.kind === "branch_selector") {
      const branch = props.viewModel().session.branches[index];
      await props.onIntent(
        branch
          ? {
              version: 1,
              type: "select_branch",
              branchId: branch.branchId,
              expectedRevision: props.viewModel().session.revision,
            }
          : {
              version: 1,
              type: "fork_branch",
              fromBranchId: props.viewModel().session.currentBranchId,
              expectedRevision: props.viewModel().session.revision,
            },
      );
    } else if (props.surface.kind === "theme_selector") {
      await props.onIntent({
        version: 1,
        type: "select_theme",
        themeId: index === 0 ? "dex" : "system",
      });
    } else if (props.surface.kind === "diff_source_selector") {
      const source = (["working_tree", "branch", "last_turn"] as const)[index];
      if (source) await props.onIntent({ version: 1, type: "open_diff_viewer", source });
      return;
    } else if (props.surface.kind === "command_palette") {
      const entry = entries()[index];
      if (entry) await props.onCommand?.(entry.id);
    } else return;
    await props.onIntent({ version: 1, type: "close_surface" });
  };
  const handleKey = (event: KeyEvent) => {
    const count = itemCount();
    if (count === 0) return;
    if (event.name === "up" || event.name === "down") {
      event.preventDefault();
      event.stopPropagation();
      setSelectedIndex((value) => (value + (event.name === "up" ? -1 : 1) + count) % count);
    } else if (event.name === "return") {
      event.preventDefault();
      event.stopPropagation();
      void chooseSelected();
    }
  };
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
      onKeyDown={handleKey}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={props.theme().colors.primary}>{surfaceTitle(props.surface)}</text>
        <text fg={props.theme().colors.textMuted}>Esc close</text>
      </box>
      <Show when={props.surface.kind === "session_selector"}>
        <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
          <box
            paddingLeft={1}
            onMouseUp={() => void props.onIntent({ version: 1, type: "new_session" })}
          >
            <text fg={props.theme().colors.primary}>+ New Session</text>
          </box>
          <For each={props.viewModel().catalog.sessions}>
            {(session) => (
              <box
                flexDirection="column"
                paddingLeft={1}
                marginTop={1}
                onMouseUp={() =>
                  void props.onIntent({ version: 1, type: "open_session", ref: session.ref })
                }
              >
                <text fg={props.theme().colors.text}>{session.ref.sessionId}</text>
                <text fg={props.theme().colors.textMuted}>
                  {session.workspace.root} · rev {session.revision}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show when={props.surface.kind === "model_selector"}>
        <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
          <For each={props.viewModel().catalog.models}>
            {(model) => (
              <box
                flexDirection="column"
                paddingLeft={1}
                marginTop={1}
                onMouseUp={() =>
                  void props.onIntent({
                    version: 1,
                    type: "select_model",
                    model: { providerId: model.providerId, modelId: model.modelId },
                  })
                }
              >
                <text fg={props.theme().colors.text}>{model.displayName}</text>
                <text fg={props.theme().colors.textMuted}>
                  {model.providerId}/{model.modelId} · {model.source.kind}:{model.source.id}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show when={props.surface.kind === "branch_selector"}>
        <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
          <For each={props.viewModel().session.branches}>
            {(branch) => (
              <box
                paddingLeft={1}
                marginTop={1}
                onMouseUp={() =>
                  void props.onIntent({
                    version: 1,
                    type: "select_branch",
                    branchId: branch.branchId,
                    expectedRevision: props.viewModel().session.revision,
                  })
                }
              >
                <text
                  fg={
                    branch.branchId === props.viewModel().session.currentBranchId
                      ? props.theme().colors.primary
                      : props.theme().colors.text
                  }
                >
                  {branch.branchId} · {branch.recordCount} records
                </text>
              </box>
            )}
          </For>
          <box
            paddingLeft={1}
            marginTop={1}
            onMouseUp={() =>
              void props.onIntent({
                version: 1,
                type: "fork_branch",
                fromBranchId: props.viewModel().session.currentBranchId,
                expectedRevision: props.viewModel().session.revision,
              })
            }
          >
            <text fg={props.theme().colors.primary}>Fork current branch</text>
          </box>
        </scrollbox>
      </Show>
      <Show when={props.surface.kind === "queue"}>
        <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
          <For each={props.viewModel().queues.filter((item) => item.status !== "cancelled")}>
            {(item) => <QueueEditor {...props} item={item} />}
          </For>
        </scrollbox>
      </Show>
      <Show when={props.surface.kind === "context"}>
        <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
          <Show
            when={context()}
            fallback={<text fg={props.theme().colors.textMuted}>Context 尚未构建。</text>}
          >
            <text fg={props.theme().colors.text}>
              {context()?.measurement.inputTokens ?? 0}/
              {context()?.measurement.usableInputBudget ?? 0} input tokens
            </text>
            <For each={context()?.manifest.contributions ?? []}>
              {(item) => (
                <text
                  fg={
                    item.disposition === "omitted"
                      ? props.theme().colors.warning
                      : props.theme().colors.textMuted
                  }
                >
                  {item.disposition} · {item.sourceId} · {item.estimatedTokens} tokens
                </text>
              )}
            </For>
            <For each={context()?.derivations ?? []}>
              {(item) => (
                <text fg={props.theme().colors.accent}>
                  {item.status} · {item.kind} · {item.model.providerId}/{item.model.modelId}
                </text>
              )}
            </For>
            <Show when={context()?.checkpoint}>
              <text fg={props.theme().colors.accent}>
                checkpoint · {context()?.checkpoint?.checkpointId} ·{" "}
                {context()?.checkpoint?.strategyVersion}
              </text>
            </Show>
          </Show>
        </scrollbox>
      </Show>
      <Show when={props.surface.kind === "run_report" && report()}>
        <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
          <text fg={props.theme().colors.text}>
            {report()?.status} · {report()?.terminationReason}
          </text>
          <text fg={props.theme().colors.textMuted}>
            turns {report()?.counts.modelTurnCount} · attempts {report()?.counts.modelAttemptCount}{" "}
            · tools {report()?.tools.settled}/{report()?.tools.accepted}
          </text>
          <For each={report()?.changedFiles ?? []}>
            {(file) => (
              <text fg={props.theme().colors.secondary}>
                {file.change} · {file.path}
              </text>
            )}
          </For>
          <For each={report()?.commands ?? []}>
            {(command) => <text fg={props.theme().colors.textMuted}>{command.command}</text>}
          </For>
          <For each={report()?.unfinishedWork ?? []}>
            {(item) => <text fg={props.theme().colors.warning}>{item}</text>}
          </For>
          <Show when={report()?.error}>
            <text fg={props.theme().colors.error}>
              {report()?.error?.code}: {report()?.error?.message}
            </text>
          </Show>
        </scrollbox>
      </Show>
      <Show when={props.surface.kind === "theme_selector"}>
        <For each={["dex", "system"] as const}>
          {(themeId) => (
            <text
              fg={
                props.viewModel().ui.themeId === themeId
                  ? props.theme().colors.primary
                  : props.theme().colors.text
              }
              onMouseUp={() => void props.onIntent({ version: 1, type: "select_theme", themeId })}
            >
              {themeId}
            </text>
          )}
        </For>
      </Show>
      <Show when={props.surface.kind === "diff_source_selector"}>
        <For each={["working_tree", "branch", "last_turn"] as const}>
          {(source) => (
            <text
              fg={props.theme().colors.text}
              onMouseUp={() =>
                void props.onIntent({ version: 1, type: "open_diff_viewer", source })
              }
            >
              {source.replaceAll("_", " ")}
            </text>
          )}
        </For>
      </Show>
      <Show when={props.surface.kind === "help"}>
        <text fg={props.theme().colors.text}>
          Ctrl+P command palette · Ctrl+X leader · Ctrl+X i abort
        </text>
        <text fg={props.theme().colors.textMuted}>
          Enter submit · Shift+Enter newline · PgUp/PgDn transcript · ? route help
        </text>
      </Show>
      <Show when={props.surface.kind === "diagnostic"}>
        <text fg={props.theme().colors.error}>
          {
            props
              .viewModel()
              .diagnostics.find(
                (item) => item.id === (props.surface.kind === "diagnostic" ? props.surface.id : ""),
              )?.message
          }
        </text>
      </Show>
      <Show when={props.surface.kind === "command_palette" || props.surface.kind === "which_key"}>
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
            <Show
              when={props.viewModel().diffDocument}
              fallback={
                <box
                  id="diff-viewer-loading"
                  focusable
                  focused
                  width="100%"
                  height="100%"
                  justifyContent="center"
                  alignItems="center"
                >
                  <text fg={props.theme().colors.textMuted}>Loading structured Diff…</text>
                </box>
              }
            >
              {(document: () => CodingDiffDocument) => {
                const state = props.viewModel().ui.diffViewer;
                return state ? (
                  <OpenTuiDiffViewer
                    document={document()}
                    state={state}
                    terminal={props.viewModel().ui.terminal}
                    theme={props.theme()}
                    syntaxStyle={props.syntaxStyle()}
                    onSelectFile={(filePath) =>
                      props.onIntent({ version: 1, type: "select_diff_file", filePath })
                    }
                  />
                ) : null;
              }}
            </Show>
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
              <Show when={layout().statusRows > 0}>
                <box
                  id={latestDiagnostic() ? "diagnostic-region" : "terminal-summary"}
                  flexShrink={0}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={props.theme().colors.backgroundElement}
                >
                  <Show
                    when={latestDiagnostic()}
                    fallback={
                      <text fg={props.theme().colors.textMuted}>
                        {props.viewModel().session.currentBranchId} ·{" "}
                        {props.viewModel().activeRun?.config?.model.providerId ?? "model"}/
                        {props.viewModel().activeRun?.config?.model.modelId ?? "not selected"} ·
                        context {props.viewModel().context?.measurement.inputTokens ?? 0} · queue{" "}
                        {
                          props
                            .viewModel()
                            .queues.filter(
                              (item) => item.status === "queued" || item.status === "draft",
                            ).length
                        }
                      </text>
                    }
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
                  </Show>
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
