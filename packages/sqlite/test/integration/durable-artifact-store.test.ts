import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSqlitePersistence } from "../../src/index.js";

async function* chunks(): AsyncIterable<Uint8Array> {
  yield Buffer.from("hello ", "utf8");
  yield Buffer.from("durable artifact", "utf8");
}

async function readText(
  store: Awaited<ReturnType<typeof createSqlitePersistence>>["artifacts"],
  ref: { readonly id: string },
  maxBytes?: number,
): Promise<string> {
  const parts: Uint8Array[] = [];
  for await (const part of store.read(ref, maxBytes === undefined ? {} : { maxBytes })) {
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
}

describe("durable content-addressed ArtifactStore", () => {
  it("streaming write 经过 digest commit，close/reopen 后只能通过 ArtifactRef 读取", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m3-artifact-"));
    const options = {
      databasePath: path.join(root, "state.sqlite3"),
      artifactDirectory: path.join(root, "artifacts"),
      lease: { ownerId: "artifact-test", durationMs: 30_000 },
      previewRedactor: (text: string) => text.replace("durable", "[REDACTED]"),
    } as const;
    const first = await createSqlitePersistence(options);
    const ref = await first.artifacts.put({
      bytes: chunks(),
      mediaType: "text/plain",
      provenance: "tool:call-1:stdout",
    });
    const metadata = await first.artifacts.stat(ref);
    expect(metadata).toEqual({
      id: "sha256:9ff10715124167d2a4640498e97c6829c4a29b88c56cb2657889c3ce547604c4",
      digest: {
        algorithm: "sha256",
        hex: "9ff10715124167d2a4640498e97c6829c4a29b88c56cb2657889c3ce547604c4",
      },
      byteLength: 22,
      mediaType: "text/plain",
      provenance: "tool:call-1:stdout",
      preview: "hello [REDACTED] artifact",
    });
    expect(JSON.stringify(metadata)).not.toContain(root);
    await expect(first.artifacts.verify(ref)).resolves.toEqual({ status: "verified" });
    await expect(readText(first.artifacts, ref, 5)).resolves.toBe("hello");
    await first[Symbol.asyncDispose]();

    const reopened = await createSqlitePersistence(options);
    await expect(reopened.artifacts.stat(ref)).resolves.toEqual(metadata);
    await expect(readText(reopened.artifacts, ref)).resolves.toBe("hello durable artifact");
    await reopened[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  });

  it("ToolOutcome 不能 commit 未存在、pending 或 digest 损坏的 ArtifactRef", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m3-artifact-reference-"));
    const persistence = await createSqlitePersistence({
      databasePath: path.join(root, "state.sqlite3"),
      artifactDirectory: path.join(root, "artifacts"),
      lease: { ownerId: "artifact-reference", durationMs: 30_000 },
    });
    const session = await persistence.sessions.create({
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
    });
    const snapshot = await session.inspect();
    const lease = await session.beginRun({
      branchId: snapshot.currentBranchId,
      initialMessages: [{ role: "user", text: "produce artifact" }],
      metadata: { task: "produce artifact", configurationRevision: "m3" },
    });
    await lease.append([
      {
        kind: "assistant_message",
        message: {
          role: "assistant",
          content: [{ type: "tool_call", callId: "call-1", name: "run_command", arguments: {} }],
          finishReason: "tool_calls",
        },
      },
    ]);
    await lease.markToolCallStarted("call-1");
    await expect(
      lease.append([
        {
          kind: "tool_outcome",
          outcome: {
            callId: "call-1",
            status: "output_limit",
            isError: true,
            modelContent: "missing artifact",
            effectState: "unknown",
            abortObserved: false,
            artifacts: [{ id: `sha256:${"0".repeat(64)}` }],
          },
        },
      ]),
    ).rejects.toMatchObject({ code: "SESSION_CORRUPT" });
    const branch = await session.readBranch({ branchId: snapshot.currentBranchId });
    expect(branch.records.filter((record) => record.kind === "tool_outcome")).toHaveLength(0);

    await persistence[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  });
});
