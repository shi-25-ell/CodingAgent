import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import {
  createDiffViewerDocument,
  createDiffViewerLocalState,
  createOpenTuiSyntaxStyle,
  reconcileDiffViewerDocumentState,
  resolveInteractiveTheme,
  resolveOpenTuiTheme,
} from "../../src/modes/interactive/index.js";
import { OpenTuiDiffViewer } from "../../src/modes/interactive/opentui-diff-viewer.jsx";

const document = createDiffViewerDocument({
  version: 1,
  revision: "frame:1",
  source: "working_tree",
  files: [
    {
      path: "src/值.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: [
        "--- a/src/value.ts",
        "+++ b/src/value.ts",
        "@@ -1 +1 @@",
        "-export const value = 1;",
        "+export const value = 2;",
      ].join("\n"),
    },
    {
      path: "docs/readme.md",
      status: "created",
      additions: 1,
      deletions: 0,
      patch: "--- /dev/null\n+++ b/docs/readme.md\n@@ -0,0 +1 @@\n+# Dex Code",
    },
  ],
});

describe("OpenTUI V6-A Diff Viewer", () => {
  it("full-screen frame 同时呈现 file tree、连续 patches、Unicode path 与 semantic counts", async () => {
    const theme = resolveOpenTuiTheme(resolveInteractiveTheme({ mode: "dark" }));
    const syntax = createOpenTuiSyntaxStyle(theme);
    const state = reconcileDiffViewerDocumentState(
      createDiffViewerLocalState({ source: "working_tree", returnFocus: "composer" }),
      document,
    );
    const setup = await testRender(
      () => (
        <OpenTuiDiffViewer
          document={document}
          state={state}
          terminal={{ width: 142, height: 24 }}
          theme={theme}
          syntaxStyle={syntax}
        />
      ),
      { width: 142, height: 24, useThread: false },
    );
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Diff");
      expect(frame).toContain("Working tree");
      expect(frame).toContain("2 files · all · split");
      expect(frame).toContain("值.ts");
      expect(frame).toContain("readme.md");
      expect(frame).toContain("export const value = 1;");
      expect(frame).toContain("export const value = 2;");
      expect(frame).toContain("# Dex Code");
      expect(setup.renderer.currentFocusedRenderable?.id).toBe("diff-viewer");
    } finally {
      syntax.destroy();
      setup.renderer.destroy();
    }
  });
});
