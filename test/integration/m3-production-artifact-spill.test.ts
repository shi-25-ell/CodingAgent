import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { createGitWorkspaceService, createOpenAiCodingAgent } from "@coding-agent/coding";
import { modelId, providerId } from "@coding-agent/model";
import { createEnvironmentCredentialSource } from "@coding-agent/model/auth";
import type { OpenAiTransport } from "@coding-agent/model/providers/openai-compatible";
import { createSqlitePersistence } from "@coding-agent/sqlite";

async function* body(value: string): AsyncIterable<string> {
  yield value;
}

function toolResponse(command: string): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "spill-call",
              type: "function",
              function: { name: "run_command", arguments: JSON.stringify({ command }) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  })}\n\ndata: [DONE]\n\n`;
}

async function readArtifact(
  store: Awaited<ReturnType<typeof createSqlitePersistence>>["artifacts"],
  ref: { readonly id: string },
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of store.read(ref)) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

describe("M3 production Artifact spill", () => {
  it("CodingToolHost 大输出 spill 到 durable Artifact，close/reopen 后按 digest 读取", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m3-production-artifact-"));
    const workspace = path.join(root, "workspace");
    const dataDirectory = path.join(root, "data");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace);
    expect(spawnSync("git", ["init", "-q"], { cwd: workspace }).status).toBe(0);
    expect(
      spawnSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-q",
          "-m",
          "fixture",
        ],
        { cwd: workspace },
      ).status,
    ).toBe(0);
    let attempt = 0;
    const transport: OpenAiTransport = {
      async send() {
        attempt += 1;
        return attempt === 1
          ? {
              status: 200,
              headers: {},
              body: body(toolResponse(`bun -e "process.stdout.write('A'.repeat(150000))"`)),
            }
          : {
              status: 200,
              headers: {},
              body: body(
                'data: {"choices":[{"index":0,"delta":{"content":"artifact spill verified"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              ),
            };
      },
    };
    const clock = new ManualClock(1_000);
    const ids = new SequentialIdFactory();
    const application = await createOpenAiCodingAgent({
      workspaceRoot: workspace,
      dataDirectory,
      modelId: "gpt-m3-artifact",
      models: [
        {
          providerId: providerId("openai"),
          modelId: modelId("gpt-m3-artifact"),
          displayName: "M3 Artifact Fixture",
          capabilities: {
            toolCalls: "multiple",
            toolChoice: ["auto"],
            reasoning: false,
            reasoningReplay: false,
            contextWindow: 32_768,
            maxOutputTokens: 4_096,
          },
          source: { kind: "testing", id: "m3-artifact", revision: "1" },
        },
      ],
      credentialSources: [
        createEnvironmentCredentialSource({
          id: "m3-artifact",
          values: { FAST_OPENAI_API_KEY: "artifact-fixture-credential" },
          variables: { "openai.default": "FAST_OPENAI_API_KEY" },
        }),
      ],
      transport,
      clock,
      ids,
      permissionMode: "autonomous",
    });
    const session = await application.agent.createSession({
      workspace: (await createGitWorkspaceService().inspect(workspace)).binding,
    });
    const run = await session.startRun({ task: "generate large command output" });
    const report = await run.finished;
    expect(report).toMatchObject({
      status: "completed",
      finalAnswer: "artifact spill verified",
      tools: { accepted: 1, settled: 1, succeeded: 0, failed: 1 },
    });
    await application.dispose();

    const reopened = await createSqlitePersistence({
      databasePath: path.join(dataDirectory, "state.sqlite3"),
      artifactDirectory: path.join(dataDirectory, "artifacts"),
      lease: { ownerId: "artifact-reopen", durationMs: 30_000 },
      clock,
      ids,
    });
    const durableSession = await reopened.sessions.open(session.ref);
    const snapshot = await durableSession.inspect();
    const branch = await durableSession.readBranch({ branchId: snapshot.currentBranchId });
    const outcomeRecord = branch.records.find(
      (record) => record.kind === "tool_outcome" && record.outcome.callId === "spill-call",
    );
    if (!outcomeRecord || outcomeRecord.kind !== "tool_outcome") {
      throw new Error("durable ToolOutcome missing");
    }
    expect(outcomeRecord.outcome.status).toBe("output_limit");
    const artifact = outcomeRecord.outcome.artifacts[0];
    if (!artifact) throw new Error("durable ArtifactRef missing");
    expect(typeof artifact.id).toBe("string");
    await expect(reopened.artifacts.verify(artifact)).resolves.toEqual({ status: "verified" });
    const storedOutput = JSON.parse(await readArtifact(reopened.artifacts, artifact));
    expect(storedOutput).toMatchObject({ exitCode: 0, stderr: "" });
    expect(storedOutput.stdout).toBe("A".repeat(150_000));

    await reopened[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  }, 15_000);
});
