import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { createGitWorkspaceService, createOpenAiCodingAgent } from "@coding-agent/coding";
import { createEnvironmentCredentialSource } from "@coding-agent/model/auth";
import type { OpenAiTransport } from "@coding-agent/model/providers/openai-compatible";
import { createSqlitePersistence } from "@coding-agent/sqlite";

async function* body(value: string): AsyncIterable<string> {
  yield value;
}

describe("M4 production Context sources", () => {
  it("project instructions 与显式 selected skill 进入真实请求及 durable manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m4-production-context-"));
    const workspace = path.join(root, "workspace");
    const skill = path.join(workspace, ".fast", "skills", "review");
    const data = path.join(root, "data");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(workspace, "AGENTS.md"), "PROJECT-CONTEXT-MARKER", "utf8");
    await writeFile(
      path.join(skill, "skill.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "review",
        version: "1.0.0",
        description: "review changes",
        instructions: "SKILL.md",
        resources: [],
      }),
      "utf8",
    );
    await writeFile(path.join(skill, "SKILL.md"), "SKILL-CONTEXT-MARKER", "utf8");
    expect(spawnSync("git", ["init", "-q"], { cwd: workspace }).status).toBe(0);
    expect(spawnSync("git", ["add", "-A"], { cwd: workspace }).status).toBe(0);
    expect(
      spawnSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-q",
          "-m",
          "fixture",
        ],
        { cwd: workspace },
      ).status,
    ).toBe(0);
    const clock = new ManualClock(1_000);
    const ids = new SequentialIdFactory();
    const persistence = await createSqlitePersistence({
      databasePath: path.join(data, "state.sqlite3"),
      artifactDirectory: path.join(data, "artifacts"),
      lease: { ownerId: "m4-production", durationMs: 30_000 },
      clock,
      ids,
    });
    const transport: OpenAiTransport = {
      async send(request) {
        const wire = JSON.parse(request.body) as { readonly messages: readonly unknown[] };
        const serialized = JSON.stringify(wire.messages);
        expect(serialized).toContain("PROJECT-CONTEXT-MARKER");
        expect(serialized).toContain("SKILL-CONTEXT-MARKER");
        return {
          status: 200,
          headers: {},
          body: body(
            'data: {"choices":[{"index":0,"delta":{"content":"context sources verified"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          ),
        };
      },
    };
    const application = await createOpenAiCodingAgent({
      workspaceRoot: workspace,
      persistence,
      selectedSkillIds: ["review"],
      credentialSources: [
        createEnvironmentCredentialSource({
          id: "m4-context",
          values: { FAST_OPENAI_API_KEY: "fixture" },
          variables: { "openai.default": "FAST_OPENAI_API_KEY" },
        }),
      ],
      transport,
      clock,
      ids,
      maxOutputTokens: 128,
    });

    const binding = (await createGitWorkspaceService().inspect(workspace)).binding;
    const session = await application.agent.createSession({ workspace: binding });
    const report = await (await session.startRun({ task: "use selected context" })).finished;
    expect(report).toMatchObject({ status: "completed", finalAnswer: "context sources verified" });
    const durable = await persistence.sessions.open(session.ref);
    const manifest = (await durable.readContextManifests(report.runId))[0];
    expect(manifest?.version).toBe(2);
    if (!manifest || manifest.version !== 2) throw new Error("M4 Context Manifest 缺失");
    expect(manifest.contributions).toContainEqual(
      expect.objectContaining({ sourceId: "project_instructions", disposition: "selected" }),
    );
    expect(manifest.contributions).toContainEqual(
      expect.objectContaining({
        sourceId: "selected_skills",
        disposition: "selected",
        provenance: expect.objectContaining({
          kind: "skill",
          id: "review",
          digest: expect.stringMatching(/^sha256:/),
        }),
      }),
    );

    await application.dispose();
    await persistence[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  });
});
