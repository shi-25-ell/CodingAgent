import { describe, expect, it } from "bun:test";
import { ScriptedModel, scriptedTextResponse } from "@coding-agent/model/testing";
import { runPrintEntry } from "../../src/modes/print/index.js";
import { createDeterministicCodingAgent } from "../../src/testing/index.js";

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

describe("print entry", () => {
  it("拒绝缺失或未知参数并使用 CLI input exit code", async () => {
    const application = createDeterministicCodingAgent({ model: new ScriptedModel([]) });
    const missing = captureIo();
    const unknown = captureIo();

    const missingResult = await runPrintEntry([], {
      agent: application.agent,
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
      io: missing.io,
    });
    const unknownResult = await runPrintEntry(["--unknown"], {
      agent: application.agent,
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
      io: unknown.io,
    });

    expect(missingResult).toEqual({ exitCode: 2, status: "usage_error" });
    expect(unknownResult).toEqual({ exitCode: 2, status: "usage_error" });
    expect(missing.stderr[0]).toContain('用法: dex --print "Coding Task"');
    expect(unknown.stderr[0]).toMatch(/未知参数/);
    await application.dispose();
  });

  it("completed 只向 stdout 输出 final answer", async () => {
    const application = createDeterministicCodingAgent({
      model: new ScriptedModel([
        { outcome: { status: "completed", response: scriptedTextResponse("最终答案") } },
      ]),
    });
    const capture = captureIo();

    const result = await runPrintEntry(["--print", "检查项目"], {
      agent: application.agent,
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
      io: capture.io,
    });

    expect(result).toMatchObject({ exitCode: 0, status: "completed" });
    expect(capture.stdout).toEqual(["最终答案\n"]);
    expect(capture.stderr).toEqual([]);
    await application.dispose();
  });
});
