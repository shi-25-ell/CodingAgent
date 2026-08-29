import { immutableReadonlySet } from "../../projection/immutable-readonly-set.js";
import type {
  CodingDiffDocument,
  CodingDiffFile,
  DiffViewerHunkSelection,
  DiffViewerLocalState,
  DiffViewerSource,
  DiffViewerView,
  UiFocusRegion,
} from "./contracts.js";

export type DiffViewerFileStatus = "created" | "modified" | "deleted";

export type DiffViewerFile = CodingDiffFile;
export type DiffViewerDocument = CodingDiffDocument;

export interface DiffViewerTreeRow {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly kind: "directory" | "file";
  readonly depth: number;
  readonly expanded?: boolean;
  readonly file?: DiffViewerFile;
}

export interface DiffViewerHunk {
  readonly filePath: string;
  readonly hunkIndex: number;
  readonly header: string;
}

export interface DiffViewerLayout {
  readonly fileTreeColumns: number;
  readonly patchColumns: number;
  readonly splitAvailable: boolean;
  readonly view: DiffViewerView;
}

export interface ResolveDiffViewerLayoutOptions {
  readonly terminalWidth: number;
  readonly fileCount: number;
  readonly fileTreeVisible: boolean;
  readonly viewPreference?: "auto" | "stacked";
  readonly viewOverride?: DiffViewerView;
}

export const diffViewerLayoutTokens = Object.freeze({
  fileTreeColumns: 32,
  fileTreeSeparatorColumns: 1,
  routePaddingColumns: 4,
  minimumSplitPatchColumns: 100,
});

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} 必须是非负整数`);
  return value;
}

function normalizePath(value: string): string {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.length === 0) throw new RangeError("diff file path 不能为空");
  return path;
}

/**
 * Validates the application-owned, redacted diff snapshot at the presentation seam.
 * This Module never reads Git or workspace files.
 */
export function createDiffViewerDocument(input: DiffViewerDocument): DiffViewerDocument {
  if (input.revision.trim().length === 0) throw new RangeError("diff revision 不能为空");
  const seen = new Set<string>();
  const files = input.files.map((file) => {
    const path = normalizePath(file.path);
    if (seen.has(path)) throw new RangeError(`diff file path 重复: ${path}`);
    seen.add(path);
    const normalized = {
      path,
      status: file.status,
      additions: nonNegativeInteger(file.additions, `${path} additions`),
      deletions: nonNegativeInteger(file.deletions, `${path} deletions`),
      ...(file.patch !== undefined ? { patch: file.patch } : {}),
      ...(file.filetype ? { filetype: file.filetype } : {}),
    } satisfies DiffViewerFile;
    return Object.freeze(normalized);
  });
  return Object.freeze({
    version: 1,
    revision: input.revision,
    source: input.source,
    files: Object.freeze(files),
  });
}

export function createDiffViewerLocalState(options: {
  readonly source: DiffViewerSource;
  readonly returnFocus: UiFocusRegion;
  readonly file?: string;
}): DiffViewerLocalState {
  const selectedFilePath = options.file ? normalizePath(options.file) : undefined;
  return Object.freeze({
    source: options.source,
    focus: "patches",
    fileTreeVisible: true,
    patchMode: "all",
    ...(selectedFilePath ? { selectedFilePath } : {}),
    reviewedFilePaths: immutableReadonlySet<string>(),
    expandedDirectoryPaths: immutableReadonlySet<string>(),
    scrollTop: 0,
    returnFocus: options.returnFocus,
  });
}

export function reconcileDiffViewerDocumentState(
  state: DiffViewerLocalState,
  document: DiffViewerDocument,
): DiffViewerLocalState {
  if (state.source !== document.source) {
    throw new Error("diff document source 与 route source 不匹配");
  }
  if (state.documentRevision === document.revision) return state;
  const filePaths = new Set(document.files.map((file) => file.path));
  const firstLoad = state.documentRevision === undefined;
  const selectedFilePath =
    state.selectedFilePath && filePaths.has(state.selectedFilePath)
      ? state.selectedFilePath
      : document.files[0]?.path;
  const validDirectories = allDiffDirectoryPaths(document.files);
  const expandedDirectoryPaths = firstLoad
    ? validDirectories
    : immutableReadonlySet(
        [...state.expandedDirectoryPaths].filter((path) => validDirectories.has(path)),
      );
  const reviewedFilePaths = immutableReadonlySet(
    [...state.reviewedFilePaths].filter((path) => filePaths.has(path)),
  );
  const selectedHunk =
    state.selectedHunk && filePaths.has(state.selectedHunk.filePath)
      ? state.selectedHunk
      : undefined;
  const {
    documentRevision: _documentRevision,
    selectedFilePath: _selectedFilePath,
    selectedHunk: _selectedHunk,
    ...stableState
  } = state;
  return Object.freeze({
    ...stableState,
    documentRevision: document.revision,
    ...(selectedFilePath ? { selectedFilePath } : {}),
    ...(selectedHunk ? { selectedHunk } : {}),
    reviewedFilePaths,
    expandedDirectoryPaths,
  });
}

export function resolveDiffViewerLayout(options: ResolveDiffViewerLayoutOptions): DiffViewerLayout {
  if (!Number.isInteger(options.terminalWidth) || options.terminalWidth < 1) {
    throw new RangeError("terminalWidth 必须是正整数");
  }
  nonNegativeInteger(options.fileCount, "fileCount");
  const showTree = options.fileTreeVisible && options.fileCount > 0;
  const fileTreeColumns = showTree ? diffViewerLayoutTokens.fileTreeColumns : 0;
  const separators = showTree ? diffViewerLayoutTokens.fileTreeSeparatorColumns : 0;
  const patchColumns = Math.max(
    1,
    options.terminalWidth -
      fileTreeColumns -
      separators -
      diffViewerLayoutTokens.routePaddingColumns,
  );
  const splitAvailable = patchColumns >= diffViewerLayoutTokens.minimumSplitPatchColumns;
  const defaultView = options.viewPreference === "stacked" ? "unified" : "split";
  const view = splitAvailable ? (options.viewOverride ?? defaultView) : "unified";
  return Object.freeze({ fileTreeColumns, patchColumns, splitAvailable, view });
}

interface MutableTreeNode {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly children: Map<string, MutableTreeNode>;
  file?: DiffViewerFile;
}

function treeRoot(): MutableTreeNode {
  return { name: "", path: "", kind: "directory", children: new Map() };
}

function compareNodes(left: MutableTreeNode, right: MutableTreeNode): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name);
}

export function allDiffDirectoryPaths(files: readonly DiffViewerFile[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const file of files) {
    const segments = normalizePath(file.path).split("/");
    for (let index = 1; index < segments.length; index += 1) {
      paths.add(segments.slice(0, index).join("/"));
    }
  }
  return immutableReadonlySet(paths);
}

export function buildDiffViewerFileTree(
  files: readonly DiffViewerFile[],
  expandedDirectoryPaths: ReadonlySet<string>,
): readonly DiffViewerTreeRow[] {
  const root = treeRoot();
  for (const file of files) {
    const normalizedPath = normalizePath(file.path);
    const segments = normalizedPath.split("/");
    let parent = root;
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index] ?? "";
      const nodePath = segments.slice(0, index + 1).join("/");
      const kind = index === segments.length - 1 ? "file" : "directory";
      let node = parent.children.get(name);
      if (!node) {
        node = { name, path: nodePath, kind, children: new Map() };
        parent.children.set(name, node);
      }
      if (kind === "file") node.file = file;
      parent = node;
    }
  }

  const rows: DiffViewerTreeRow[] = [];
  const visit = (node: MutableTreeNode, depth: number) => {
    const expanded = node.kind === "directory" && expandedDirectoryPaths.has(node.path);
    rows.push(
      Object.freeze({
        id: `${node.kind}:${node.path}`,
        path: node.path,
        name: node.name,
        kind: node.kind,
        depth,
        ...(node.kind === "directory" ? { expanded } : {}),
        ...(node.file ? { file: node.file } : {}),
      }),
    );
    if (node.kind === "directory" && expanded) {
      [...node.children.values()].sort(compareNodes).forEach((child) => {
        visit(child, depth + 1);
      });
    }
  };
  [...root.children.values()].sort(compareNodes).forEach((node) => {
    visit(node, 0);
  });
  return Object.freeze(rows);
}

export function visibleDiffViewerFiles(
  document: DiffViewerDocument,
  state: DiffViewerLocalState,
): readonly DiffViewerFile[] {
  if (state.patchMode === "all") return document.files;
  const selected =
    document.files.find((file) => file.path === state.selectedFilePath) ?? document.files[0];
  return selected ? Object.freeze([selected]) : Object.freeze([]);
}

export function moveDiffFileSelection(
  files: readonly DiffViewerFile[],
  currentPath: string | undefined,
  offset: -1 | 1,
): string | undefined {
  if (files.length === 0) return undefined;
  const currentIndex = currentPath ? files.findIndex((file) => file.path === currentPath) : -1;
  if (currentIndex < 0) return files[0]?.path;
  const nextIndex = Math.max(0, Math.min(files.length - 1, currentIndex + offset));
  return files[nextIndex]?.path;
}

export function collectDiffViewerHunks(
  files: readonly DiffViewerFile[],
): readonly DiffViewerHunk[] {
  const hunks = files.flatMap((file) => {
    if (!file.patch) return [];
    let hunkIndex = 0;
    return file.patch.split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith("@@")) return [];
      return [Object.freeze({ filePath: file.path, hunkIndex: hunkIndex++, header: line })];
    });
  });
  return Object.freeze(hunks);
}

export function moveDiffHunkSelection(
  hunks: readonly DiffViewerHunk[],
  current: DiffViewerHunkSelection | undefined,
  offset: -1 | 1,
): DiffViewerHunkSelection | undefined {
  if (hunks.length === 0) return undefined;
  const currentIndex = current
    ? hunks.findIndex(
        (hunk) => hunk.filePath === current.filePath && hunk.hunkIndex === current.hunkIndex,
      )
    : -1;
  const nextIndex =
    currentIndex < 0 ? 0 : Math.max(0, Math.min(hunks.length - 1, currentIndex + offset));
  const next = hunks[nextIndex];
  return next ? Object.freeze({ filePath: next.filePath, hunkIndex: next.hunkIndex }) : undefined;
}
