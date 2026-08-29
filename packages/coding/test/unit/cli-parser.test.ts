import { describe, expect, it } from "bun:test";
import { CliUsageError } from "../../src/cli/contracts.js";
import { parseCli } from "../../src/cli/parser.js";

describe("CLI parser", () => {
  it("无参数选择 interactive，print 汇集统一 Run overrides", () => {
    expect(parseCli([])).toMatchObject({ type: "interactive" });
    expect(
      parseCli([
        "--print",
        "修复测试",
        "--provider",
        "glm",
        "--model",
        "glm-4.5-air",
        "--permission",
        "safe",
        "--max-model-turns",
        "8",
        "--tools",
        "read_file,apply_patch",
        "--extension",
        "sample",
        "--skill",
        "sample.echo",
        "--json",
      ]),
    ).toEqual({
      type: "print",
      task: "修复测试",
      overrides: {
        provider: "glm",
        model: "glm-4.5-air",
        permissionMode: "safe",
        maxModelTurns: 8,
        tools: ["read_file", "apply_patch"],
        extensions: ["sample"],
        skills: ["sample.echo"],
        structured: true,
      },
    });
  });

  it("解析完整 command surface", () => {
    expect(parseCli(["session", "list", "--json"])).toEqual({
      type: "session_list",
      structured: true,
    });
    expect(parseCli(["session", "resume", "s-1", "--model", "gpt-5"])).toMatchObject({
      type: "session_resume",
      sessionId: "s-1",
      overrides: { model: "gpt-5" },
    });
    expect(parseCli(["extensions", "diagnose"])).toEqual({
      type: "extensions_diagnose",
      structured: false,
    });
  });

  it("拒绝 unknown、非法值与重复安全相关 override", () => {
    expect(() => parseCli(["--print", "x", "--permission", "unsafe"])).toThrow(CliUsageError);
    expect(() => parseCli(["--print", "x", "--skill", "a", "--skill", "a"])).toThrow(/不能重复/);
    expect(() => parseCli(["session", "remove", "s-1"])).toThrow(/未知 command/);
  });
});
