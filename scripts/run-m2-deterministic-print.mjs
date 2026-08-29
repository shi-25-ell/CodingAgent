#!/usr/bin/env -S bun --no-env-file
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createGitWorkspaceService, createOpenAiCodingAgent } from "@coding-agent/coding";
import { runPrintEntry } from "@coding-agent/coding/print";
import { modelId, providerId } from "@coding-agent/model";
import { createEnvironmentCredentialSource } from "@coding-agent/model/auth";

function toolResponse(callId, name, args) {
  return `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  })}\n\ndata: [DONE]\n\n`;
}

function finalResponse(text) {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
  })}\n\ndata: [DONE]\n\n`;
}

const responses = [
  toolResponse("list-1", "list_files", { path: ".", recursive: true }),
  toolResponse("read-1", "read_file", { path: "math.js" }),
  toolResponse("search-1", "search_text", { query: "return a - b", path: "." }),
  toolResponse("patch-1", "apply_patch", {
    path: "math.js",
    oldText: "return a - b;",
    newText: "return a + b;",
  }),
  toolResponse("verify-1", "run_command", { command: "bun test.mjs" }),
  toolResponse("status-1", "git_status", {}),
  toolResponse("diff-1", "git_diff", { path: "math.js" }),
  finalResponse("已修复加法实现，项目测试通过，Git evidence 已核验。"),
];

let attempt = 0;
const transport = {
  async send(request) {
    if (attempt > 0) {
      const wire = JSON.parse(request.body);
      const last = wire.messages.at(-1);
      if (attempt < responses.length - 1 && (last?.role !== "tool" || last.content.length === 0)) {
        throw new Error(`attempt ${attempt + 1} 缺少完整 ToolOutcome continuation`);
      }
    }
    const payload = responses[attempt];
    attempt += 1;
    if (payload === undefined) throw new Error("M2 deterministic transport exhausted");
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
  modelId: "gpt-m2-test",
  models: [
    {
      providerId: providerId("openai"),
      modelId: modelId("gpt-m2-test"),
      displayName: "GPT M2 Deterministic Test",
      capabilities: {
        toolCalls: "multiple",
        toolChoice: ["auto", "none", "required", "specific"],
        reasoning: false,
        reasoningReplay: false,
        contextWindow: 32_768,
        maxOutputTokens: 4_096,
      },
      source: { kind: "testing", id: "m2-deterministic", revision: "1" },
    },
  ],
  credentialSources: [
    createEnvironmentCredentialSource({
      id: "m2-deterministic-environment",
      values: { DEX_OPENAI_API_KEY: `credential-${randomUUID()}` },
      variables: { "openai.default": "DEX_OPENAI_API_KEY" },
    }),
  ],
  transport,
  permissionMode: "autonomous",
});

try {
  const workspace = (await createGitWorkspaceService().inspect(process.cwd())).binding;
  const result = await runPrintEntry(process.argv.slice(2), {
    agent: application.agent,
    workspace,
    io: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
  });
  if (attempt !== responses.length) {
    throw new Error(
      `M2 deterministic transport 尚有 ${responses.length - attempt} 个未消费 response`,
    );
  }
  const reportPath = process.env.FAST_M2_REPORT_PATH;
  if (reportPath && "report" in result) {
    const [summary] = await application.agent.listSessions();
    if (!summary) throw new Error("M2 deterministic Session 未创建");
    const view = await (await application.agent.openSession(summary.ref)).inspect();
    await writeFile(
      reportPath,
      JSON.stringify({
        sessionRef: summary.ref,
        report: result.report,
        terminalTimelineCount: view.timeline.filter((entry) => entry.type === "terminal").length,
      }),
      "utf8",
    );
  }
  process.exitCode = result.exitCode;
} finally {
  await application.dispose();
}
