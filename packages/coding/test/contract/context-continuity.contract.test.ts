import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { createEnvironmentCredentialSource } from "@coding-agent/model/auth";
import type { OpenAiTransport } from "@coding-agent/model/providers/openai-compatible";
import { describe, expect, it } from "vitest";
import { createOpenAiCodingAgent } from "../../src/composition/openai-composition.js";
import { createGitWorkspaceService } from "../../src/workspace/workspace-service.js";

async function* body(value: string): AsyncIterable<string> {
  yield value;
}

function initializeGit(root: string): void {
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  expect(spawnSync("git", ["add", "-A"], { cwd: root }).status).toBe(0);
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
      { cwd: root },
    ).status,
  ).toBe(0);
}

function credentialSource() {
  return createEnvironmentCredentialSource({
    id: "context-continuity",
    values: { FAST_OPENAI_API_KEY: "fixture" },
    variables: { "openai.default": "FAST_OPENAI_API_KEY" },
  });
}

describe("production Context continuity", () => {
  it("canonical root 的 instructions/skills 使用 immutable snapshot，restart 变化时 fail closed", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "fast-context-continuity-"));
    const workspace = path.join(temporary, "workspace");
    const subdirectory = path.join(workspace, "packages", "demo");
    const skillDirectory = path.join(workspace, ".fast", "skills", "review");
    const dataDirectory = path.join(temporary, "data");
    await mkdir(subdirectory, { recursive: true });
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(workspace, "AGENTS.md"), "ROOT-INSTRUCTIONS", "utf8");
    await writeFile(
      path.join(skillDirectory, "skill.json"),
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
    await writeFile(path.join(skillDirectory, "SKILL.md"), "SKILL-V1", "utf8");
    initializeGit(workspace);

    let firstRequestCount = 0;
    const firstTransport: OpenAiTransport = {
      async send(request) {
        firstRequestCount += 1;
        expect(request.body).toContain("ROOT-INSTRUCTIONS");
        expect(request.body).not.toContain("CHANGED-INSTRUCTIONS");
        expect(request.body).toContain("SKILL-V1");
        return {
          status: 200,
          headers: {},
          body: body(
            'data: {"choices":[{"index":0,"delta":{"content":"first"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          ),
        };
      },
    };
    const first = await createOpenAiCodingAgent({
      workspaceRoot: subdirectory,
      dataDirectory,
      selectedSkillIds: ["review"],
      credentialSources: [credentialSource()],
      transport: firstTransport,
      clock: new ManualClock(1_000),
      ids: new SequentialIdFactory(),
      maxOutputTokens: 128,
    });
    const binding = (await createGitWorkspaceService().inspect(subdirectory)).binding;
    const session = await first.agent.createSession({ workspace: binding });
    expect((await (await session.startRun({ task: "first" })).finished).status).toBe("completed");
    await writeFile(path.join(workspace, "AGENTS.md"), "CHANGED-INSTRUCTIONS", "utf8");
    expect((await (await session.startRun({ task: "snapshot remains" })).finished).status).toBe(
      "completed",
    );
    expect(firstRequestCount).toBe(2);
    await first.dispose();

    let secondRequestSeen = false;
    const second = await createOpenAiCodingAgent({
      workspaceRoot: workspace,
      dataDirectory,
      selectedSkillIds: ["review"],
      credentialSources: [credentialSource()],
      transport: {
        async send() {
          secondRequestSeen = true;
          throw new Error("configuration mismatch 不应调用 Model");
        },
      },
      clock: new ManualClock(2_000),
      ids: new SequentialIdFactory(),
      maxOutputTokens: 128,
    });
    const reopened = await second.agent.openSession(session.ref);
    await expect(reopened.startRun({ task: "second" })).rejects.toMatchObject({
      code: "CODING_CONTEXT_CONFIGURATION_MISMATCH",
    });
    expect(secondRequestSeen).toBe(false);
    expect((await reopened.inspect()).activeRunId).toBeUndefined();
    await second.dispose();

    await writeFile(path.join(workspace, "AGENTS.md"), "ROOT-INSTRUCTIONS", "utf8");
    await writeFile(path.join(skillDirectory, "SKILL.md"), "SKILL-V2", "utf8");
    const third = await createOpenAiCodingAgent({
      workspaceRoot: workspace,
      dataDirectory,
      selectedSkillIds: ["review"],
      credentialSources: [credentialSource()],
      transport: {
        async send() {
          throw new Error("changed Skill configuration 不应调用 Model");
        },
      },
      clock: new ManualClock(3_000),
      ids: new SequentialIdFactory(),
      maxOutputTokens: 128,
    });
    const reopenedForSkillChange = await third.agent.openSession(session.ref);
    await expect(reopenedForSkillChange.startRun({ task: "third" })).rejects.toMatchObject({
      code: "CODING_CONTEXT_CONFIGURATION_MISMATCH",
    });
    await third.dispose();
    await rm(temporary, { recursive: true, force: true });
  });
});
