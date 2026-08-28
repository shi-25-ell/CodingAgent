import { describe, expect, it } from "vitest";
import {
  InMemorySessionRepository,
  ManualClock,
  SequentialIdFactory,
} from "../../src/testing/index.js";

describe("InMemorySessionRepository contract", () => {
  it("创建、列出、打开和分支都通过 Session public Interface 保持 revision", async () => {
    const repository = new InMemorySessionRepository({
      clock: new ManualClock(1_000),
      ids: new SequentialIdFactory(),
    });
    const created = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });

    const initial = await created.inspect();
    expect(initial).toMatchObject({ revision: 1 });
    expect(initial.activeRunId).toBeUndefined();
    expect(initial.branches).toHaveLength(1);
    expect(await repository.list()).toEqual([
      expect.objectContaining({ ref: created.ref, revision: 1 }),
    ]);

    const branch = await created.forkBranch({
      fromBranchId: initial.currentBranchId,
      expectedRevision: initial.revision,
    });
    const selected = await created.selectBranch(branch.branchId, 2);
    expect(selected.currentBranchId).toBe(branch.branchId);
    expect(selected.revision).toBe(3);

    const reopened = await repository.open(created.ref);
    expect(await reopened.inspect()).toEqual(selected);
    await repository[Symbol.asyncDispose]();
  });

  it("同一 Session 只允许一个 active Run", async () => {
    const repository = new InMemorySessionRepository({
      clock: new ManualClock(),
      ids: new SequentialIdFactory(),
    });
    const session = await repository.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const lease = await session.beginRun({
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "first" }],
      metadata: { task: "first", configurationRevision: "m0" },
    });

    await expect(
      session.beginRun({
        branchId: snapshot.currentBranchId,
        initialMessages: [{ role: "user", text: "second" }],
        metadata: { task: "second", configurationRevision: "m0" },
      }),
    ).rejects.toMatchObject({ code: "SESSION_ACTIVE_RUN" });

    await lease[Symbol.asyncDispose]();
    await repository[Symbol.asyncDispose]();
  });
});
