#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createOpenAiCodingAgent } from "@coding-agent/coding";
import { runPrintEntry } from "@coding-agent/coding/print";
import { modelId, providerId } from "@coding-agent/model";
import { createEnvironmentCredentialSource } from "@coding-agent/model/auth";

const fixtureRoot = fileURLToPath(new URL("../test/fixtures/openai/", import.meta.url));
const responses = await Promise.all([
  readFile(`${fixtureRoot}tool-call.sse`, "utf8"),
  readFile(`${fixtureRoot}final-answer.sse`, "utf8"),
]);
let attempt = 0;
const transport = {
  async send() {
    const payload = responses[attempt];
    attempt += 1;
    if (payload === undefined) throw new Error("deterministic transport exhausted");
    return {
      status: 200,
      headers: {},
      body: (async function* () {
        yield payload;
      })(),
    };
  },
};
const application = await createOpenAiCodingAgent({
  workspaceRoot: process.cwd(),
  modelId: "gpt-test",
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
  credentialSources: [
    createEnvironmentCredentialSource({
      id: "deterministic-environment",
      values: { FAST_OPENAI_API_KEY: `credential-${randomUUID()}` },
      variables: { "openai.default": "FAST_OPENAI_API_KEY" },
    }),
  ],
  transport,
});
try {
  const result = await runPrintEntry(process.argv.slice(2), {
    agent: application.agent,
    workspace: { root: process.cwd(), fingerprint: "deterministic-m1" },
    io: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
  });
  process.exitCode = result.exitCode;
} finally {
  await application.dispose();
}
