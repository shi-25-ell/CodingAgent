import { open } from "node:fs/promises";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { createSqlitePersistence } from "@coding-agent/sqlite";

const [databasePath, artifactDirectory, effectPath, crashPoint] = process.argv.slice(2);
if (!databasePath || !artifactDirectory || !effectPath || !crashPoint) {
  throw new Error("crash fixture arguments are incomplete");
}

const persistence = await createSqlitePersistence({
  databasePath,
  artifactDirectory,
  lease: { ownerId: `crash-${crashPoint}`, durationMs: 100 },
  clock: new ManualClock(0),
  ids: new SequentialIdFactory(),
});
const session = await persistence.sessions.create({
  workspace: { root: "D:/work/crash", fingerprint: "head:crash" },
});
const snapshot = await session.inspect();
const lease = await session.beginRun({
  branchId: snapshot.currentBranchId,
  initialMessages: [{ role: "user", text: "perform one external effect" }],
  metadata: { task: "perform one external effect", configurationRevision: "m3-crash" },
});
await lease.markModelTurnStarted(1);
await lease.commitContext({
  version: 1,
  id: `${lease.runId}:attempt-1`,
  runId: lease.runId,
  modelAttemptCount: 1,
  selectedRecordIds: [],
  omitted: [],
});
await lease.append([
  {
    kind: "assistant_message",
    message: {
      role: "assistant",
      content: [
        { type: "tool_call", callId: "effect-call", name: "fixture_effect", arguments: {} },
      ],
      finishReason: "tool_calls",
    },
  },
]);
if (crashPoint === "after-assistant") process.exit(91);

await lease.markToolCallStarted("effect-call");
const effect = await open(effectPath, "a", 0o600);
await effect.writeFile("effect\n", "utf8");
await effect.sync();
await effect.close();
if (crashPoint === "after-tool-start") process.exit(92);

await lease.append([
  {
    kind: "tool_outcome",
    outcome: {
      callId: "effect-call",
      status: "succeeded",
      isError: false,
      modelContent: "effect committed",
      effectState: "committed",
      abortObserved: false,
      artifacts: [],
    },
  },
]);
if (crashPoint === "after-outcome") process.exit(93);
throw new Error(`unknown crash point: ${crashPoint}`);
