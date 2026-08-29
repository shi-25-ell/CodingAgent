import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { type CredentialSource, SecretString } from "@coding-agent/model/auth";
import type { OpenAiTransport } from "@coding-agent/model/providers/openai-compatible";
import { createOpenAiCodingAgent } from "../../packages/coding/src/composition/openai-composition.js";
import { runPrintEntry } from "../../packages/coding/src/modes/print/print-entry.js";
import { createGitWorkspaceService } from "../../packages/coding/src/workspace/workspace-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function* body(value: string): AsyncIterable<string> {
  yield value;
}

describe("M5.4 sample extension production composition", () => {
  it("discovery -> skill context -> ToolHost -> RunReport 全链路可达", async () => {
    const root = await temporary("dex-m54-extension-workspace-");
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
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
    const credentials: readonly CredentialSource[] = [
      {
        id: "extension-fixture",
        async resolve() {
          return {
            status: "found",
            credential: { kind: "api_key", value: new SecretString("fixture") },
            sourceId: "extension-fixture",
          };
        },
      },
    ];
    let attempt = 0;
    const transport: OpenAiTransport = {
      async send(request) {
        attempt += 1;
        const wire = JSON.parse(request.body) as { tools?: unknown[]; messages?: unknown[] };
        expect(JSON.stringify(wire.tools)).toContain("sample_echo");
        if (attempt === 1) {
          expect(request.body).toContain("sample extension");
          return {
            status: 200,
            headers: {},
            body: body(
              'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"sample-call","type":"function","function":{"name":"sample_echo","arguments":"{\\"text\\":\\"hello\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}\n\ndata: [DONE]\n\n',
            ),
          };
        }
        expect(wire.messages).toBeDefined();
        return {
          status: 200,
          headers: {},
          body: body(
            'data: {"choices":[{"index":0,"delta":{"content":"sample complete"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n',
          ),
        };
      },
    };
    const application = await createOpenAiCodingAgent({
      workspaceRoot: root,
      dataDirectory: await temporary("dex-m54-extension-data-"),
      credentialSources: credentials,
      transport,
      clock: new ManualClock(1_000),
      ids: new SequentialIdFactory(),
      maxOutputTokens: 128,
      webSearchProfile: "disabled",
      enabledExtensionIds: ["dex.sample"],
      extensionSources: [{ kind: "explicit", path: path.resolve("examples/sample-extension") }],
      selectedSkillIds: ["sample.echo"],
    });
    try {
      const workspace = (await createGitWorkspaceService().inspect(root)).binding;
      const result = await runPrintEntry(["--print", "use sample"], {
        agent: application.agent,
        workspace,
        io: { stdout: () => {}, stderr: () => {} },
      });
      expect(result).toMatchObject({
        status: "completed",
        report: {
          finalAnswer: "sample complete",
          tools: { accepted: 1, settled: 1, succeeded: 1 },
        },
      });
      const diagnostics = await application.agent.diagnostics();
      expect(diagnostics.extensions.map((item) => item.manifest.id)).toEqual(["dex.sample"]);
      expect(diagnostics.skills.map((item) => item.id)).toContain("sample.echo");
      expect(diagnostics.extensionDiagnostics.filter((item) => item.severity === "error")).toEqual(
        [],
      );
    } finally {
      await application.dispose();
    }
  }, 15_000);
});
