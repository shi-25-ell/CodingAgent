import { describe, expect, it } from "bun:test";
import { ScriptedModel, scriptedTextResponse } from "@coding-agent/model/testing";
import { reduceProjection, selectTuiViewModel } from "../../src/projection/projection.js";
import { createDeterministicCodingAgent } from "../../src/testing/index.js";

describe("Coding projection snapshot/live contract", () => {
  it("snapshot + live 与 terminal 后 reopen snapshot 选择出相同 TuiViewModel", async () => {
    const model = new ScriptedModel([
      { outcome: { status: "completed", response: scriptedTextResponse("stable answer") } },
    ]);
    const application = createDeterministicCodingAgent({ model });
    const session = await application.agent.createSession({
      workspace: { root: "D:/work/projection", fingerprint: "head:abc" },
    });
    const handle = await session.startRun({ task: "project me" });
    const joined = await handle.snapshot();
    let live = reduceProjection(undefined, joined.snapshot);
    for await (const event of handle.events(joined.cursor)) live = reduceProjection(live, event);
    await handle.finished;

    const reopened = await application.agent.openSession(session.ref);
    const replayed = reduceProjection(undefined, await reopened.snapshot());
    expect(selectTuiViewModel(live)).toEqual(selectTuiViewModel(replayed));
    expect(reopened.activeRun()).toBeUndefined();
    model.assertConsumed();
    await application.dispose();
  });
});
