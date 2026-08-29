import { describe, expect, it } from "bun:test";
import {
  buildDiffViewerFileTree,
  collectDiffViewerHunks,
  createDiffViewerDocument,
  createDiffViewerLocalState,
  moveDiffFileSelection,
  moveDiffHunkSelection,
  reconcileDiffViewerDocumentState,
  resolveDiffViewerLayout,
  visibleDiffViewerFiles,
} from "../../src/modes/interactive/index.js";

const document = createDiffViewerDocument({
  version: 1,
  revision: "working-tree:7",
  source: "working_tree",
  files: [
    {
      path: "src/main.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: [
        "--- a/src/main.ts",
        "+++ b/src/main.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "@@ -8 +8 @@",
        "-before",
        "+after",
      ].join("\n"),
    },
    {
      path: "docs/说明.md",
      status: "created",
      additions: 3,
      deletions: 0,
      patch: "@@ -0,0 +1 @@\n+# Dex Code",
    },
  ],
});

describe("V6-A diff viewer policy", () => {
  it("application diff snapshot 在 Adapter seam 校验、规范化并冻结", () => {
    expect(document.files.map((file) => file.path)).toEqual(["src/main.ts", "docs/说明.md"]);
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.files)).toBe(true);
    expect(() =>
      createDiffViewerDocument({
        version: 1,
        revision: "duplicate",
        source: "branch",
        files: [
          { path: "src\\a.ts", status: "modified", additions: 0, deletions: 0 },
          { path: "src/a.ts", status: "modified", additions: 0, deletions: 0 },
        ],
      }),
    ).toThrow(/重复/);
  });

  it("32-column tree 后 patch pane 至少 100 columns 才启用 split", () => {
    expect(
      resolveDiffViewerLayout({
        terminalWidth: 136,
        fileCount: 2,
        fileTreeVisible: true,
      }),
    ).toEqual({ fileTreeColumns: 32, patchColumns: 99, splitAvailable: false, view: "unified" });
    expect(
      resolveDiffViewerLayout({
        terminalWidth: 137,
        fileCount: 2,
        fileTreeVisible: true,
      }),
    ).toEqual({ fileTreeColumns: 32, patchColumns: 100, splitAvailable: true, view: "split" });
    expect(
      resolveDiffViewerLayout({
        terminalWidth: 137,
        fileCount: 2,
        fileTreeVisible: true,
        viewPreference: "stacked",
        viewOverride: "split",
      }).view,
    ).toBe("split");
    expect(
      resolveDiffViewerLayout({
        terminalWidth: 80,
        fileCount: 2,
        fileTreeVisible: false,
        viewOverride: "split",
      }).view,
    ).toBe("unified");
  });

  it("首次 document reconcile 展开目录并选择首文件，revision 更新保留有效状态", () => {
    const initial = createDiffViewerLocalState({ source: "working_tree", returnFocus: "composer" });
    const ready = reconcileDiffViewerDocumentState(initial, document);
    expect(ready).toMatchObject({
      documentRevision: "working-tree:7",
      selectedFilePath: "src/main.ts",
      returnFocus: "composer",
    });
    expect([...ready.expandedDirectoryPaths]).toEqual(["src", "docs"]);
    expect(buildDiffViewerFileTree(document.files, ready.expandedDirectoryPaths)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "directory", path: "docs", expanded: true }),
        expect.objectContaining({ kind: "file", path: "docs/说明.md", depth: 1 }),
      ]),
    );
    expect(reconcileDiffViewerDocumentState(ready, document)).toBe(ready);
  });

  it("all/single patch、file navigation 与跨文件 hunk navigation 使用 stable path identity", () => {
    const ready = reconcileDiffViewerDocumentState(
      createDiffViewerLocalState({ source: "working_tree", returnFocus: "transcript" }),
      document,
    );
    expect(visibleDiffViewerFiles(document, ready)).toHaveLength(2);
    expect(
      visibleDiffViewerFiles(document, { ...ready, patchMode: "single" }).map((file) => file.path),
    ).toEqual(["src/main.ts"]);
    expect(moveDiffFileSelection(document.files, "src/main.ts", 1)).toBe("docs/说明.md");
    expect(moveDiffFileSelection(document.files, "docs/说明.md", 1)).toBe("docs/说明.md");

    const hunks = collectDiffViewerHunks(document.files);
    expect(hunks).toHaveLength(3);
    const first = moveDiffHunkSelection(hunks, undefined, 1);
    const second = moveDiffHunkSelection(hunks, first, 1);
    const third = moveDiffHunkSelection(hunks, second, 1);
    expect(first).toEqual({ filePath: "src/main.ts", hunkIndex: 0 });
    expect(second).toEqual({ filePath: "src/main.ts", hunkIndex: 1 });
    expect(third).toEqual({ filePath: "docs/说明.md", hunkIndex: 0 });
  });
});
