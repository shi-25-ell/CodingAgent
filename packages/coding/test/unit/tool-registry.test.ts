import { describe, expect, it } from "bun:test";
import { ToolRegistry } from "../../src/tools/tool-registry.js";

const definition = {
  name: "example",
  description: "example tool",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
} as const;

describe("ToolRegistry", () => {
  it("按注册顺序生成 immutable snapshot 并提供 deterministic lookup", () => {
    const registry = new ToolRegistry();
    registry.register({ definition });
    registry.register({ definition: { ...definition, name: "second" } });
    expect(() =>
      registry.register({ definition: { ...definition, name: "example" } }),
    ).toThrowError(/重复 tool name: example/);
    const snapshot = registry.snapshot();

    expect(snapshot.definitions().map((item) => item.name)).toEqual(["example", "second"]);
    expect(snapshot.lookup("example")?.definition.name).toBe("example");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.definitions())).toBe(true);
  });

  it("freeze 后拒绝注册，schema 缺少 additionalProperties:false 时 fail closed", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        definition: {
          ...definition,
          name: "unsafe",
          inputSchema: { type: "object", properties: {} },
        },
      }),
    ).toThrowError(/additionalProperties/);

    registry.register({ definition });
    registry.snapshot();
    expect(() => registry.register({ definition: { ...definition, name: "late" } })).toThrowError(
      /已冻结/,
    );
  });

  it("strict validation 拒绝缺字段、额外字段、错误类型且不 coercion", () => {
    const registry = new ToolRegistry();
    registry.register({ definition });
    const tool = registry.snapshot().lookup("example");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("tool 未注册");

    expect(tool.validate({ value: "ok" })).toEqual({ valid: true, value: { value: "ok" } });
    expect(tool.validate({})).toMatchObject({ valid: false });
    expect(tool.validate({ value: "ok", extra: true })).toMatchObject({ valid: false });
    expect(tool.validate({ value: 1 })).toMatchObject({ valid: false });
    expect(tool.validate("value=ok")).toMatchObject({ valid: false });
  });
});
