import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import type { CredentialSource } from "@coding-agent/model/auth";
import type { AnthropicTransport } from "@coding-agent/model/providers/anthropic";
import type { OpenAiTransport } from "@coding-agent/model/providers/openai-compatible";
import {
  createProviderCodingAgent,
  type ProductionProviderId,
} from "../../packages/coding/src/composition/openai-composition.js";
import { runPrintEntry } from "../../packages/coding/src/modes/print/index.js";
import { createGitWorkspaceService } from "../../packages/coding/src/workspace/workspace-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10 })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
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
        "--allow-empty",
        "-q",
        "-m",
        "fixture",
      ],
      { cwd: root },
    ).status,
  ).toBe(0);
}

async function* body(value: string): AsyncIterable<string> {
  yield value;
}

function fixtureCredentials(secret: string): readonly CredentialSource[] {
  return [
    {
      id: "m5-fixture",
      async resolve() {
        const { SecretString } = await import("@coding-agent/model/auth");
        return {
          status: "found",
          credential: { kind: "api_key", value: new SecretString(secret) },
          sourceId: "m5-fixture",
        };
      },
    },
  ];
}

interface ScenarioResult {
  readonly report: unknown;
  readonly timeline: unknown;
}

async function runScenario(
  provider: "anthropic" | "deepseek",
  root: string,
): Promise<ScenarioResult> {
  let attempt = 0;
  const secret = `${provider}-composition-secret`;
  const anthropicTransport: AnthropicTransport = {
    async send(request) {
      attempt += 1;
      expect(request.url).toBe("https://api.anthropic.com/v1/messages");
      expect(request.headers["x-api-key"]).toBe(secret);
      const wire = JSON.parse(request.body) as { messages: unknown[] };
      if (attempt === 1) {
        return {
          status: 200,
          headers: {},
          body: body(
            'event: message_start\ndata: {"type":"message_start","message":{"content":[],"usage":{"input_tokens":8,"output_tokens":0}}}\n\n' +
              'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n' +
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"inspect"}}\n\n' +
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed-replay"}}\n\n' +
              'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
              'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-read","name":"read_file","input":{}}}\n\n' +
              'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"answer.txt\\"}"}}\n\n' +
              'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n' +
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n' +
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ),
        };
      }
      expect(JSON.stringify(wire.messages)).toContain("signed-replay");
      expect(JSON.stringify(wire.messages)).toContain("canonical fixture");
      return {
        status: 200,
        headers: {},
        body: body(
          'event: message_start\ndata: {"type":"message_start","message":{"content":[],"usage":{"input_tokens":12,"output_tokens":0}}}\n\n' +
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"canonical complete"}}\n\n' +
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ),
      };
    },
  };
  const openAiTransport: OpenAiTransport = {
    async send(request) {
      attempt += 1;
      expect(request.url).toBe("https://api.deepseek.com/chat/completions");
      expect(request.headers.authorization).toBe(`Bearer ${secret}`);
      const wire = JSON.parse(request.body) as { messages: unknown[] };
      if (attempt === 1) {
        return {
          status: 200,
          headers: {},
          body: body(
            'data: {"choices":[{"index":0,"delta":{"reasoning_content":"inspect","tool_calls":[{"index":0,"id":"call-read","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"answer.txt\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":5,"total_tokens":13}}\n\ndata: [DONE]\n\n',
          ),
        };
      }
      expect(JSON.stringify(wire.messages)).toContain("canonical fixture");
      return {
        status: 200,
        headers: {},
        body: body(
          'data: {"choices":[{"index":0,"delta":{"content":"canonical complete"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}\n\ndata: [DONE]\n\n',
        ),
      };
    },
  };
  const application = await createProviderCodingAgent({
    provider,
    workspaceRoot: root,
    dataDirectory: await temporaryDirectory(`fast-m5-${provider}-data-`),
    credentialSources: fixtureCredentials(secret),
    clock: new ManualClock(2_000),
    ids: new SequentialIdFactory(),
    maxOutputTokens: 128,
    webSearchProfile: "disabled",
    anthropicTransport,
    openAiTransport,
  });
  try {
    const result = await runPrintEntry(["--print", "读取 answer.txt"], {
      agent: application.agent,
      workspace: (await createGitWorkspaceService().inspect(root)).binding,
      io: { stdout: () => {}, stderr: () => {} },
    });
    if (!("report" in result)) throw new Error(`fixture print 未完成: ${result.status}`);
    const sessions = await application.agent.listSessions();
    const session = await application.agent.openSession(sessions[0]?.ref as never);
    return { report: result.report, timeline: (await session.inspect()).timeline };
  } finally {
    await application.dispose();
  }
}

describe("M5 production provider composition", () => {
  it("runs the same tool-use scenario through Anthropic and DeepSeek with canonical state", async () => {
    const root = await temporaryDirectory("fast-m5-provider-");
    await writeFile(path.join(root, "answer.txt"), "canonical fixture", "utf8");
    initializeGit(root);
    const anthropic = await runScenario("anthropic", root);
    const deepseek = await runScenario("deepseek", root);
    expect(anthropic.report).toMatchObject({
      status: "completed",
      finalAnswer: "canonical complete",
      counts: { modelTurnCount: 2, modelAttemptCount: 2, toolCallCount: 1 },
      tools: { accepted: 1, settled: 1, succeeded: 1, failed: 0 },
    });
    expect(deepseek.report).toEqual(anthropic.report);
    expect(deepseek.timeline).toEqual(anthropic.timeline);
  }, 15_000);

  it.each([
    ["deepseek", "deepseek-v4-pro", 128_000],
    ["glm", "glm-5.2", 1_000_000],
    ["glm", "glm-4.5-air", 128_000],
    ["anthropic", "claude-sonnet-4-5-20250929", 200_000],
  ] as const)(
    "selects %s explicitly with catalog diagnostics",
    async (provider, model, contextWindow) => {
      const root = await temporaryDirectory(`fast-m5-${provider}-selection-`);
      const application = await createProviderCodingAgent({
        provider: provider as ProductionProviderId,
        workspaceRoot: root,
        modelId: model,
        dataDirectory: await temporaryDirectory(`fast-m5-${provider}-selection-data-`),
        credentialSources: fixtureCredentials("selection-secret"),
        webSearchProfile: "disabled",
      });
      expect(await application.agent.diagnostics()).toMatchObject({
        model: { providerId: provider, modelId: model, capabilities: { contextWindow } },
      });
      await application.dispose();
    },
  );

  it.each(["deepseek", "glm", "anthropic"] as const)(
    "%s missing credential fails before transport or persistence setup",
    async (provider) => {
      const root = await temporaryDirectory(`fast-m5-${provider}-missing-`);
      await expect(
        createProviderCodingAgent({
          provider,
          workspaceRoot: root,
          credentialSources: [
            {
              id: "missing",
              async resolve() {
                return { status: "missing" };
              },
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    },
  );
});
