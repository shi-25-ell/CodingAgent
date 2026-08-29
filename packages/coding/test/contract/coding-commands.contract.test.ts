import { describe, expect, it } from "bun:test";
import { ManualGate } from "@coding-agent/agent/testing";
import { ScriptedModel, scriptedTextResponse } from "@coding-agent/model/testing";
import { createDeterministicCodingAgent } from "../../src/testing/index.js";

describe("CodingSession frontend commands", () => {
  it("queue edit 使用 revision CAS，activeRun/abort 只经过 application seam", async () => {
    const gate = new ManualGate();
    const model = new ScriptedModel([
      {
        before: async (signal) => {
          await gate.wait(signal);
        },
        outcome: { status: "completed", response: scriptedTextResponse("not reached") },
      },
    ]);
    const application = createDeterministicCodingAgent({ model });
    const session = await application.agent.createSession({
      workspace: { root: "D:/work/commands", fingerprint: "head:abc" },
    });
    const handle = await session.startRun({ task: "wait for commands" });
    await gate.waitUntilBlocked();
    expect(session.activeRun()?.runId).toBe(handle.runId);

    await expect(
      handle.dispatch({ commandId: "queue-1", type: "steer", text: "first text" }),
    ).resolves.toMatchObject({ status: "accepted" });
    const [queued] = await session.listQueue(handle.runId);
    if (!queued) throw new Error("queue item 未创建");
    const updated = await handle.dispatch({
      commandId: "edit-1",
      type: "update_queue",
      targetCommandId: queued.commandId,
      expectedRevision: queued.revision,
      text: "updated text",
      status: "queued",
    });
    expect(updated).toMatchObject({ status: "accepted", queueItem: { text: "updated text" } });
    await expect(
      handle.dispatch({
        commandId: "edit-stale",
        type: "update_queue",
        targetCommandId: queued.commandId,
        expectedRevision: queued.revision,
        text: "stale text",
        status: "queued",
      }),
    ).resolves.toMatchObject({ status: "conflict" });

    await handle.dispatch({ commandId: "abort-1", type: "abort", reason: "test complete" });
    await expect(handle.finished).resolves.toMatchObject({ status: "aborted" });
    expect(session.activeRun()).toBeUndefined();
    model.assertConsumed();
    await application.dispose();
  });
});
