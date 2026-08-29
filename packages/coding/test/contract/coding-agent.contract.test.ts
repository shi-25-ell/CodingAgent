import { describe, expect, it } from "bun:test";
import { ScriptedModel, scriptedTextResponse } from "@coding-agent/model/testing";
import { createDeterministicCodingAgent } from "../../src/testing/index.js";

describe("CodingAgent facade contract", () => {
  it("通过 facade 创建 Session、启动 Run 并读取 product projection", async () => {
    const model = new ScriptedModel([
      { outcome: { status: "completed", response: scriptedTextResponse("工作完成") } },
    ]);
    const application = createDeterministicCodingAgent({ model });
    const session = await application.agent.createSession({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });

    const run = await session.startRun({ task: "完成工作" });
    const report = await run.finished;
    const view = await session.inspect();

    expect(report).toMatchObject({ status: "completed", finalAnswer: "工作完成" });
    expect(view.timeline).toEqual([
      { type: "user", text: "完成工作" },
      { type: "assistant", text: "工作完成" },
      expect.objectContaining({ type: "terminal", status: "completed" }),
    ]);
    expect(await application.agent.listModels()).toEqual([model.descriptor]);
    expect(application.agent.listModes()).toEqual([{ id: "print", displayName: "Print" }]);
    model.assertConsumed();
    await application.dispose();
  });
});
