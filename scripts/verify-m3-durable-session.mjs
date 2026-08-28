#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createOpenAiCodingAgent } from "@coding-agent/coding";
import { modelId, providerId } from "@coding-agent/model";
import { createEnvironmentCredentialSource } from "@coding-agent/model/auth";

const [evidencePath, dataDirectory] = process.argv.slice(2);
if (!evidencePath || !dataDirectory) {
  throw new Error("usage: verify-m3-durable-session.mjs <evidence-path> <data-directory>");
}

const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
if (!evidence.sessionRef?.sessionId || !evidence.report?.runId) {
  throw new Error("evidence 缺少 SessionRef 或 RunReport");
}

const application = await createOpenAiCodingAgent({
  workspaceRoot: process.cwd(),
  dataDirectory,
  modelId: "gpt-m3-reopen-verifier",
  models: [
    {
      providerId: providerId("openai"),
      modelId: modelId("gpt-m3-reopen-verifier"),
      displayName: "M3 Reopen Verifier",
      capabilities: {
        toolCalls: "multiple",
        toolChoice: ["auto"],
        reasoning: false,
        reasoningReplay: false,
      },
      source: { kind: "testing", id: "m3-reopen-verifier", revision: "1" },
    },
  ],
  credentialSources: [
    createEnvironmentCredentialSource({
      id: "m3-reopen-verifier",
      values: { FAST_OPENAI_API_KEY: "reopen-verifier-not-sent" },
      variables: { "openai.default": "FAST_OPENAI_API_KEY" },
    }),
  ],
  transport: {
    async send() {
      throw new Error("durable Session verifier 不得发起 model request");
    },
  },
});

try {
  const session = await application.agent.openSession(evidence.sessionRef);
  const view = await session.inspect();
  const report = await session.readRunReport(evidence.report.runId);
  if (!report) throw new Error("reopen 后 RunReport 不存在");
  await writeFile(
    evidencePath,
    JSON.stringify({
      ...evidence,
      reopened: {
        view,
        report,
        terminalTimelineCount: view.timeline.filter((entry) => entry.type === "terminal").length,
      },
    }),
    "utf8",
  );
} finally {
  await application.dispose();
}
