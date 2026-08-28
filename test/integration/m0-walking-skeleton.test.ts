import { runPrintEntry } from "@coding-agent/coding/print";
import { createDeterministicCodingAgent } from "@coding-agent/coding/testing";
import { ScriptedModel, scriptedTextResponse } from "@coding-agent/model/testing";
import { describe, expect, it } from "vitest";

describe("CLI → CodingAgent → AgentHarness → Agent → Model → RunReport", () => {
  it("真实 Node CLI 进程使用显式 deterministic composition", () => {
    const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
    const entry = fileURLToPath(
      new URL("../../scripts/run-deterministic-print.mjs", import.meta.url),
    );
    const result = spawnSync(process.execPath, [entry, "--print", "进程级任务"], {
      cwd: workspaceRoot,
      env: { ...process.env, FAST_SCRIPTED_RESPONSE: "进程级答案" },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("进程级答案\n");
    expect(result.stderr).toBe("");
  });

  it("无工具任务只走一条 production-shaped path，并可从 facade 复核 durable projection", async () => {
    const model = new ScriptedModel([
      {
        assertRequest(request) {
          expect(request.tools).toEqual([]);
          expect(request.messages).toEqual([
            { role: "user", content: [{ type: "text", text: "解释当前状态" }] },
          ]);
        },
        outcome: {
          status: "completed",
          response: scriptedTextResponse("状态正常", {
            inputTokens: 6,
            outputTokens: 4,
            totalTokens: 10,
          }),
        },
      },
    ]);
    const application = createDeterministicCodingAgent({ model });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runPrintEntry(["--print", "解释当前状态"], {
      agent: application.agent,
      workspace: { root: "D:/work/demo", fingerprint: "head:abc" },
      io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    });

    expect(result).toMatchObject({
      exitCode: 0,
      status: "completed",
      report: {
        status: "completed",
        counts: { modelTurnCount: 1, modelAttemptCount: 1 },
        usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
      },
    });
    expect(stdout).toEqual(["状态正常\n"]);
    expect(stderr).toEqual([]);

    const [summary] = await application.agent.listSessions();
    expect(summary).toBeDefined();
    if (!summary) throw new Error("deterministic composition 未创建 Session");
    const session = await application.agent.openSession(summary.ref);
    const view = await session.inspect();
    expect(view.activeRunId).toBeUndefined();
    expect(view.timeline.map((entry) => entry.type)).toEqual(["user", "assistant", "terminal"]);
    model.assertConsumed();
    await application.dispose();
  });
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
