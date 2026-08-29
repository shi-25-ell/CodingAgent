import type { SyntaxStyle } from "@opentui/core";
import { For, Show } from "solid-js";
import type { DiffViewerLocalState, TerminalDimensions } from "./contracts.js";
import {
  buildDiffViewerFileTree,
  type DiffViewerDocument,
  type DiffViewerFile,
  resolveDiffViewerLayout,
  visibleDiffViewerFiles,
} from "./diff-viewer.js";
import { createOpenTuiDiffViewerOptions } from "./opentui-content-adapters.js";
import type { OpenTuiTheme } from "./opentui-theme-adapter.js";

export interface OpenTuiDiffViewerProps {
  readonly document: DiffViewerDocument;
  readonly state: DiffViewerLocalState;
  readonly terminal: TerminalDimensions;
  readonly theme: OpenTuiTheme;
  readonly syntaxStyle: SyntaxStyle;
  readonly viewPreference?: "auto" | "stacked";
  readonly onSelectFile?: (filePath: string) => void;
}

function sourceLabel(source: DiffViewerDocument["source"]): string {
  if (source === "working_tree") return "Working tree";
  if (source === "last_turn") return "Last turn";
  return "Branch";
}

function statusLabel(file: DiffViewerFile): string {
  if (file.status === "created") return "C";
  if (file.status === "deleted") return "D";
  return "M";
}

/** Dedicated V6-A route component. It only consumes structured presentation input. */
export function OpenTuiDiffViewer(props: OpenTuiDiffViewerProps) {
  const layout = () =>
    resolveDiffViewerLayout({
      terminalWidth: props.terminal.width,
      fileCount: props.document.files.length,
      fileTreeVisible: props.state.fileTreeVisible,
      ...(props.viewPreference ? { viewPreference: props.viewPreference } : {}),
      ...(props.state.viewOverride ? { viewOverride: props.state.viewOverride } : {}),
    });
  const treeRows = () =>
    buildDiffViewerFileTree(props.document.files, props.state.expandedDirectoryPaths);
  const visibleFiles = () => visibleDiffViewerFiles(props.document, props.state);
  const additions = () => props.document.files.reduce((total, file) => total + file.additions, 0);
  const deletions = () => props.document.files.reduce((total, file) => total + file.deletions, 0);

  return (
    <box
      id="diff-viewer"
      focusable
      focused
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={props.theme.colors.background}
    >
      <box
        flexDirection="row"
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        justifyContent="space-between"
        backgroundColor={props.theme.colors.backgroundPanel}
      >
        <box flexDirection="row" gap={1}>
          <text fg={props.theme.colors.primary}>Diff</text>
          <text fg={props.theme.colors.text}>{sourceLabel(props.document.source)}</text>
          <text fg={props.theme.colors.textMuted}>
            {props.document.files.length} files · {props.state.patchMode} · {layout().view}
          </text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={props.theme.diff.added}>+{additions()}</text>
          <text fg={props.theme.diff.removed}>-{deletions()}</text>
        </box>
      </box>

      <Show
        when={props.document.files.length > 0}
        fallback={
          <box flexGrow={1} paddingLeft={2} paddingTop={1}>
            <text fg={props.theme.colors.textMuted}>No diff available for this source.</text>
          </box>
        }
      >
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <Show when={layout().fileTreeColumns > 0}>
            <scrollbox
              width={layout().fileTreeColumns}
              minHeight={0}
              flexShrink={0}
              verticalScrollbarOptions={{ visible: false }}
              backgroundColor={props.theme.colors.backgroundPanel}
            >
              <For each={treeRows()}>
                {(row) => {
                  const selected = () =>
                    row.kind === "file" && row.path === props.state.selectedFilePath;
                  const reviewed = () =>
                    row.kind === "file" && props.state.reviewedFilePaths.has(row.path);
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: file-tree row supports terminal mouse selection.
                    <box
                      flexDirection="row"
                      paddingLeft={1 + row.depth * 2}
                      paddingRight={1}
                      gap={1}
                      backgroundColor={
                        selected()
                          ? props.theme.colors.backgroundSelection
                          : props.theme.colors.backgroundPanel
                      }
                      onMouseUp={() => {
                        if (row.kind === "file") props.onSelectFile?.(row.path);
                      }}
                    >
                      <text
                        fg={
                          reviewed() ? props.theme.colors.textSubtle : props.theme.colors.textMuted
                        }
                      >
                        {row.kind === "directory"
                          ? row.expanded
                            ? "-"
                            : "+"
                          : reviewed()
                            ? "R"
                            : statusLabel(row.file as DiffViewerFile)}
                      </text>
                      <text
                        fg={selected() ? props.theme.colors.selectedText : props.theme.colors.text}
                        wrapMode="none"
                        flexShrink={1}
                      >
                        {row.name}
                      </text>
                      <Show when={row.file !== undefined}>
                        <box flexDirection="row" gap={1} flexShrink={0}>
                          <text fg={props.theme.diff.added}>+{row.file?.additions ?? 0}</text>
                          <text fg={props.theme.diff.removed}>-{row.file?.deletions ?? 0}</text>
                        </box>
                      </Show>
                    </box>
                  );
                }}
              </For>
            </scrollbox>
          </Show>

          <scrollbox
            flexGrow={1}
            minWidth={1}
            minHeight={0}
            verticalScrollbarOptions={{ visible: false }}
            horizontalScrollbarOptions={{ visible: false }}
          >
            <For each={visibleFiles()}>
              {(file) => {
                const reviewed = () => props.state.reviewedFilePaths.has(file.path);
                const options = () =>
                  createOpenTuiDiffViewerOptions(file, props.theme, props.syntaxStyle, {
                    layout: layout(),
                    reviewed: reviewed(),
                  });
                return (
                  <box flexDirection="column" minWidth={1}>
                    <box
                      flexDirection="row"
                      justifyContent="space-between"
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={props.theme.colors.backgroundElement}
                    >
                      <text
                        fg={reviewed() ? props.theme.colors.textMuted : props.theme.colors.text}
                      >
                        {file.path}
                      </text>
                      <box flexDirection="row" gap={1}>
                        <text fg={props.theme.diff.added}>+{file.additions}</text>
                        <text fg={props.theme.diff.removed}>-{file.deletions}</text>
                      </box>
                    </box>
                    <Show
                      when={file.patch}
                      fallback={<text fg={props.theme.colors.textMuted}>Patch unavailable.</text>}
                    >
                      <diff {...options()} width="100%" />
                    </Show>
                  </box>
                );
              }}
            </For>
          </scrollbox>
        </box>
      </Show>

      <box
        flexDirection="row"
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        gap={2}
        backgroundColor={props.theme.colors.backgroundPanel}
      >
        <text fg={props.theme.colors.textMuted}>files/patches focus</text>
        <text fg={props.theme.colors.textMuted}>file + hunk navigation</text>
        <text fg={props.theme.colors.textMuted}>source · view · reviewed</text>
      </box>
    </box>
  );
}
