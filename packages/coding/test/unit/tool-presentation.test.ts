import { describe, expect, it } from "bun:test";
import type { ToolOutcome } from "@coding-agent/agent";
import type { JsonObject } from "@coding-agent/model";
import {
  collapseToolOutput,
  sanitizeToolOutput,
  selectToolPresentation,
} from "../../src/modes/interactive/index.js";
import type { CodingToolProjection } from "../../src/projection/contracts.js";

function outcome(
  modelContent: string,
  options: { status?: ToolOutcome["status"]; evidence?: JsonObject } = {},
): ToolOutcome {
  const status = options.status ?? "succeeded";
  return {
    callId: "call-1",
    status,
    isError: status !== "succeeded",
    modelContent,
    effectState: "none",
    abortObserved: false,
    artifacts: [],
    ...(options.evidence ? { evidence: options.evidence } : {}),
  };
}

function tool(
  toolName: string,
  status: CodingToolProjection["status"],
  settled?: ToolOutcome,
): CodingToolProjection {
  return {
    callId: "call-1",
    plan: {
      callId: "call-1",
      toolName,
      resources: [{ kind: "path", value: "src/a.ts" }],
      effects: [],
      risks: [],
    },
    status,
    ...(settled ? { outcome: settled } : {}),
  };
}

const defaults = {
  availableColumns: 100,
  showDetails: true,
  showGenericOutput: false,
} as const;

describe("semantic inline tool presentation", () => {
  it.each(["read_file", "search_text", "list_files", "web_search"])(
    "%s 使用 compact semantic row",
    (toolName) => {
      expect(selectToolPresentation(tool(toolName, "running"), defaults)).toMatchObject({
        kind: "compact_row",
        status: "running",
        tone: "running",
        visible: true,
      });
    },
  );

  it("shell 使用约 10 行 block preview，stable id 控制 expand/collapse", () => {
    const command = tool("run_command", "settled", outcome(`${"🙂\n".repeat(11)}done`));
    const collapsed = selectToolPresentation(command, defaults);
    const expanded = selectToolPresentation(command, {
      ...defaults,
      expandedIds: new Set(["tool:call-1:output"]),
    });

    expect(collapsed).toMatchObject({ kind: "output_block", output: { overflow: true } });
    expect(collapsed.output?.text.split("\n")).toHaveLength(11);
    expect(expanded.output).toMatchObject({ overflow: true, expanded: true, fullLineCount: 12 });
    expect(expanded.output?.text).toContain("done");
  });

  it("generic tool 默认隐藏 raw output，显式开启后只显示 3 行 preview", () => {
    const generic = tool("custom_tool", "settled", outcome("one\ntwo\nthree\nfour"));
    expect(selectToolPresentation(generic, defaults)).toMatchObject({
      kind: "compact_row",
      rawOutputAvailable: true,
    });
    expect(selectToolPresentation(generic, defaults).output).toBeUndefined();
    expect(
      selectToolPresentation(generic, { ...defaults, showGenericOutput: true }).output,
    ).toMatchObject({ overflow: true, fullLineCount: 4 });
  });

  it("Hide tool details 只移除 succeeded history，不隐藏 running/pending/error", () => {
    const hidden = { ...defaults, showDetails: false };
    expect(
      selectToolPresentation(tool("read_file", "settled", outcome("ok")), hidden).visible,
    ).toBe(false);
    expect(selectToolPresentation(tool("read_file", "running"), hidden).visible).toBe(true);
    expect(selectToolPresentation(tool("read_file", "planned"), hidden).visible).toBe(true);
    expect(
      selectToolPresentation(
        tool("read_file", "settled", outcome("boom", { status: "failed" })),
        hidden,
      ).visible,
    ).toBe(true);
  });

  it.each(["edit", "apply_patch"])(
    "%s 的 unified diff evidence 选择 structured inline diff",
    (toolName) => {
      const presentation = selectToolPresentation(
        tool(
          toolName,
          "settled",
          outcome("changed", {
            evidence: {
              diff: {
                format: "unified",
                text: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
                filePath: "src/a.ts",
              },
            },
          }),
        ),
        defaults,
      );

      expect(presentation).toMatchObject({
        kind: "inline_diff",
        diff: { format: "unified", filePath: "src/a.ts", filetype: "typescript" },
      });
      expect(presentation.output).toBeUndefined();
    },
  );

  it("write 根据 code metadata 选择 syntax-aware code block，否则保持 compact row", () => {
    expect(
      selectToolPresentation(
        tool(
          "write",
          "settled",
          outcome("wrote", {
            evidence: {
              code: { content: "export const value = 1;", filePath: "src/value.ts" },
            },
          }),
        ),
        defaults,
      ),
    ).toMatchObject({
      kind: "code_block",
      code: { filetype: "typescript", content: "export const value = 1;" },
    });
    expect(selectToolPresentation(tool("write", "settled", outcome("wrote")), defaults).kind).toBe(
      "compact_row",
    );
  });

  it("failure summary 始终存在，detail 可展开且清除 ANSI/control injection", () => {
    const failed = tool(
      "custom_tool",
      "settled",
      outcome("\u001b[31mfailure\u001b[0m\u0000", { status: "failed" }),
    );
    const presentation = selectToolPresentation(failed, {
      ...defaults,
      showDetails: false,
      expandedIds: new Set(["tool:call-1:error"]),
    });

    expect(presentation).toMatchObject({
      visible: true,
      failureSummary: "Tool failed",
      failureDetailAvailable: true,
      failureDetail: { text: "failure" },
    });
    expect(selectToolPresentation(failed, defaults).failureDetail).toBeUndefined();
    expect(sanitizeToolOutput("a\u001b[2Jb\u0000c")).toBe("abc");
  });

  it("collapse 以 Unicode code points 截断，不拆分 surrogate pair", () => {
    expect(collapseToolOutput("🙂🙂🙂", 1, 2, false).text).toBe("🙂…");
  });
});
