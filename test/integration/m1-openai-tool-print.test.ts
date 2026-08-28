import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManualClock, SequentialIdFactory } from "@coding-agent/agent/testing";
import { modelId, providerId } from "@coding-agent/model";
import type { CredentialSource } from "@coding-agent/model/auth";
import { createEnvironmentCredentialSource } from "@coding-agent/model/auth";
import type { OpenAiTransport } from "@coding-agent/model/providers/openai-compatible";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOpenAiCodingAgent,
  createOpenRouterCodingAgent,
} from "../../packages/coding/src/composition/openai-composition.js";
import { runPrintEntry } from "../../packages/coding/src/modes/print/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function* body(value: string): AsyncIterable<string> {
  yield value;
}

describe("M1 OpenAI-compatible coding vertical slice", () => {
  it("OpenRouter composition 从 ignored local config 解析独立 credential", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m1-openrouter-"));
    temporaryDirectories.push(root);
    const credentialPath = path.join(root, "local-credentials.json");
    await writeFile(
      credentialPath,
      JSON.stringify({ "openrouter.default": "openrouter-local-secret" }),
      "utf8",
    );

    const application = await createOpenRouterCodingAgent({
      workspaceRoot: root,
      localCredentialPath: credentialPath,
      transport: {
        async send() {
          throw new Error("composition preflight 不应发起网络请求");
        },
      },
    });

    expect(application.model).toMatchObject({
      providerId: "openrouter",
      modelId: "openrouter/free",
    });
    expect(JSON.stringify(application.model)).not.toContain("openrouter-local-secret");
    await application.dispose();
  });

  it("production CLI process 在 credential 缺失时以稳定 exit code 退出", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "fast-m1-cli-"));
    temporaryDirectories.push(repositoryRoot);
    expect(spawnSync("git", ["init", "-q"], { cwd: repositoryRoot }).status).toBe(0);
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
          "-m",
          "fixture",
          "-q",
        ],
        { cwd: repositoryRoot },
      ).status,
    ).toBe(0);
    const entry = fileURLToPath(
      new URL("../../packages/coding/dist/cli/entry.js", import.meta.url),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FAST_OPENAI_API_KEY: "",
      OPENAI_API_KEY: "",
    };
    delete env.FAST_OPENAI_MODEL;

    const result = spawnSync(process.execPath, [entry, "--print", "status"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("OpenAI credential 未配置\n");
  });

  it("production CLI process 可选择 OpenRouter composition", async () => {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "fast-m1-openrouter-cli-"));
    temporaryDirectories.push(repositoryRoot);
    expect(spawnSync("git", ["init", "-q"], { cwd: repositoryRoot }).status).toBe(0);
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
          "-m",
          "fixture",
          "-q",
        ],
        { cwd: repositoryRoot },
      ).status,
    ).toBe(0);
    const entry = fileURLToPath(
      new URL("../../packages/coding/dist/cli/entry.js", import.meta.url),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FAST_MODEL_PROVIDER: "openrouter",
      FAST_OPENROUTER_API_KEY: "",
      OPENROUTER_API_KEY: "",
    };

    const result = spawnSync(process.execPath, [entry, "--print", "status"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("OpenRouter credential 未配置\n");
  });

  it("composition 对 missing/failed credential 给出稳定错误码", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m1-auth-"));
    temporaryDirectories.push(root);
    const missing: CredentialSource = {
      id: "missing",
      async resolve() {
        return { status: "missing" };
      },
    };
    const failed: CredentialSource = {
      id: "failed",
      async resolve() {
        return {
          status: "failed",
          failure: { category: "failed", message: "private credential detail" },
        };
      },
    };

    await expect(
      createOpenAiCodingAgent({ workspaceRoot: root, credentialSources: [missing] }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    await expect(
      createOpenAiCodingAgent({ workspaceRoot: root, credentialSources: [failed] }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_RESOLUTION_FAILED" });
  });

  it("default catalog 与 local credential path 可完成无网络 composition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m1-defaults-"));
    temporaryDirectories.push(root);
    const credentialPath = path.join(root, "local-credentials.json");
    await writeFile(credentialPath, JSON.stringify({ "openai.default": "local-secret" }), "utf8");

    const application = await createOpenAiCodingAgent({
      workspaceRoot: root,
      localCredentialPath: credentialPath,
      transport: {
        async send() {
          throw new Error("composition preflight 不应发起网络请求");
        },
      },
    });

    expect(application.model).toMatchObject({ providerId: "openai", modelId: "gpt-5" });
    expect(JSON.stringify(application.model)).not.toContain("local-secret");
    await application.dispose();
  });

  it("actual Node CLI process 使用同一 production facade 完成带工具 Run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m1-process-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "answer.txt"), "process fixture", "utf8");
    const entry = fileURLToPath(
      new URL("../../scripts/run-m1-deterministic-print.mjs", import.meta.url),
    );

    const result = spawnSync(process.execPath, [entry, "--print", "read answer.txt"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("process vertical slice complete\n");
    expect(result.stderr).toBe("");
  });

  it("print mode 通过 production facade 执行工具并继续 Model Turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m1-"));
    temporaryDirectories.push(root);
    const initialCredential = `credential-initial-${randomUUID()}`;
    const runtimeCredential = `credential-rotated-${randomUUID()}`;
    const credentialValues: Record<string, string | undefined> = {
      FAST_OPENAI_API_KEY: initialCredential,
    };
    await writeFile(path.join(root, "answer.txt"), `vertical slice ${runtimeCredential}`, "utf8");
    let attempt = 0;
    const transport: OpenAiTransport = {
      async send(request) {
        attempt += 1;
        expect(request.headers.authorization).toBe(`Bearer ${runtimeCredential}`);
        const wire = JSON.parse(request.body);
        if (attempt === 1) {
          expect(wire.messages.at(-1)).toEqual({ role: "user", content: "读取 answer.txt" });
          expect(wire.max_completion_tokens).toBe(128);
          return {
            status: 200,
            headers: {},
            body: body(
              'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-read","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"answer.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
            ),
          };
        }
        expect(wire.messages.at(-1)).toMatchObject({
          role: "tool",
          tool_call_id: "call-read",
          content: expect.stringContaining("vertical slice"),
        });
        expect(wire.messages.at(-1).content).toContain("[REDACTED]");
        expect(wire.messages.at(-1).content).not.toContain(runtimeCredential);
        return {
          status: 200,
          headers: {},
          body: body(
            'data: {"choices":[{"index":0,"delta":{"content":"已完成真实工具链"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":6,"total_tokens":26}}\n\ndata: [DONE]\n\n',
          ),
        };
      },
    };
    const application = await createOpenAiCodingAgent({
      workspaceRoot: root,
      modelId: "gpt-test",
      transport,
      credentialSources: [
        createEnvironmentCredentialSource({
          id: "test-environment",
          values: credentialValues,
          variables: { "openai.default": "FAST_OPENAI_API_KEY" },
        }),
      ],
      clock: new ManualClock(1_000),
      ids: new SequentialIdFactory(),
      models: [
        {
          providerId: providerId("openai"),
          modelId: modelId("gpt-test"),
          displayName: "GPT Test",
          capabilities: {
            toolCalls: "multiple",
            toolChoice: ["auto", "none", "required", "specific"],
            reasoning: false,
            reasoningReplay: false,
          },
          source: { kind: "testing", id: "raw-wire", revision: "1" },
        },
      ],
      maxOutputTokens: 128,
    });
    credentialValues.FAST_OPENAI_API_KEY = runtimeCredential;
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runPrintEntry(["--print", "读取 answer.txt"], {
      agent: application.agent,
      workspace: { root, fingerprint: "fixture" },
      io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    });

    expect(result).toMatchObject({
      exitCode: 0,
      status: "completed",
      report: {
        finalAnswer: "已完成真实工具链",
        counts: { modelTurnCount: 2, modelAttemptCount: 2, toolCallCount: 1 },
        tools: { accepted: 1, settled: 1, succeeded: 1, failed: 0 },
      },
    });
    expect(stdout).toEqual(["已完成真实工具链\n"]);
    expect(stderr).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(runtimeCredential);
    expect(JSON.stringify(result)).not.toContain(initialCredential);
    expect(attempt).toBe(2);
    await application.dispose();
  });
});
