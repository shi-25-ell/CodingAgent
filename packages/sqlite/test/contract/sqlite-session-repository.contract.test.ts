import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { sessionRepositoryConformance } from "../../../../test/contract/session-repository.conformance.js";
import { createSqlitePersistence } from "../../src/index.js";

sessionRepositoryConformance("SQLite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fast-m3-conformance-"));
  const persistence = await createSqlitePersistence({
    databasePath: path.join(root, "state.sqlite3"),
    artifactDirectory: path.join(root, "artifacts"),
    busyTimeoutMs: 250,
    lease: { ownerId: "conformance-owner", durationMs: 30_000 },
    clock: new ManualClock(1_000),
    ids: new SequentialIdFactory(),
  });
  return {
    repository: persistence.sessions,
    async putArtifact() {
      return persistence.artifacts.put({
        bytes: new TextEncoder().encode("summary"),
        mediaType: "text/plain",
        provenance: "session-repository-conformance",
      });
    },
    async dispose() {
      await persistence[Symbol.asyncDispose]();
      await rm(root, { recursive: true, force: true });
    },
  };
});
