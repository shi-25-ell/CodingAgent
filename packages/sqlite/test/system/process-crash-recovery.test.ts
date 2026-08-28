import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runId, sessionId } from "@coding-agent/agent";
import { ManualClock } from "@coding-agent/agent/testing";
import { describe, expect, it } from "vitest";
import { createSqlitePersistence } from "../../src/index.js";

describe("SQLite independent-process crash recovery", () => {
  it.each([
    {
      point: "after-assistant",
      exitCode: 91,
      expectedEffectCount: 0,
      expectedOutcome: { status: "cancelled", effectState: "none" },
      expectedTools: { succeeded: 0, failed: 1 },
    },
    {
      point: "after-tool-start",
      exitCode: 92,
      expectedEffectCount: 1,
      expectedOutcome: { status: "failed", effectState: "unknown" },
      expectedTools: { succeeded: 0, failed: 1 },
    },
    {
      point: "after-outcome",
      exitCode: 93,
      expectedEffectCount: 1,
      expectedOutcome: { status: "succeeded", effectState: "committed" },
      expectedTools: { succeeded: 1, failed: 0 },
    },
  ])("$point crash 不 replay model/tool 且不重复 Outcome/terminal", async (scenario) => {
    const root = await mkdtemp(path.join(tmpdir(), `fast-m3-${scenario.point}-`));
    const databasePath = path.join(root, "state.sqlite3");
    const artifactDirectory = path.join(root, "artifacts");
    const effectPath = path.join(root, "effect.log");
    const fixture = path.resolve("packages/sqlite/test/fixtures/crash-run.mjs");
    const crashed = spawnSync(
      process.execPath,
      [fixture, databasePath, artifactDirectory, effectPath, scenario.point],
      { encoding: "utf8", windowsHide: true },
    );
    expect(crashed.status).toBe(scenario.exitCode);
    expect(crashed.stdout).toBe("");
    expect(crashed.stderr).toBe("");

    const persistence = await createSqlitePersistence({
      databasePath,
      artifactDirectory,
      lease: { ownerId: "recovery-process", durationMs: 100 },
      clock: new ManualClock(1_000),
    });
    const session = await persistence.sessions.open({ sessionId: sessionId("session-1") });
    const report = await session.readRunReport(runId("run-1"));
    const snapshot = await session.inspect();
    const branch = await session.readBranch({ branchId: snapshot.currentBranchId });
    const outcomes = branch.records.filter((record) => record.kind === "tool_outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ outcome: scenario.expectedOutcome });
    expect(branch.records.filter((record) => record.kind === "run_terminal")).toHaveLength(1);
    expect(report).toMatchObject({
      status: "failed",
      terminationReason: "recovered_interruption",
      tools: { accepted: 1, settled: 1, ...scenario.expectedTools },
    });
    const effects =
      scenario.expectedEffectCount === 0
        ? []
        : (await readFile(effectPath, "utf8")).trim().split(/\r?\n/);
    expect(effects).toHaveLength(scenario.expectedEffectCount);

    await persistence[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  });
});
