import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform !== "win32")("M2 real Git repository acceptance", () => {
  it("actual Bun print process 修复项目，进程外 verifier 与 Git evidence 交叉通过", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "fast-m2-acceptance-"));
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "fast-m2-evidence-"));
    const dataRoot = await mkdtemp(path.join(tmpdir(), "fast-m3-data-"));
    temporaryDirectories.push(root, evidenceRoot, dataRoot);
    await writeFile(
      path.join(root, "math.js"),
      "export function add(a, b) {\n  return a - b;\n}\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "test.mjs"),
      "import assert from 'node:assert/strict';\nimport { add } from './math.js';\nassert.equal(add(2, 3), 5);\nconsole.log('external verifier passed');\n",
      "utf8",
    );
    await writeFile(path.join(root, "package.json"), '{"type":"module"}\n', "utf8");
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);
    expect(
      spawnSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-qm",
          "fixture",
        ],
        { cwd: root },
      ).status,
    ).toBe(0);
    const entry = fileURLToPath(
      new URL("../../scripts/run-m2-deterministic-print.mjs", import.meta.url),
    );
    const reportPath = path.join(evidenceRoot, "run-report.json");

    const agentProcess = spawnSync(
      process.execPath,
      [entry, "--print", "修复 math.js 并运行测试"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          FAST_M2_REPORT_PATH: reportPath,
          FAST_DATA_HOME: dataRoot,
        },
      },
    );
    expect(agentProcess.status).toBe(0);
    expect(agentProcess.stdout).toBe("已修复加法实现，项目测试通过，Git evidence 已核验。\n");
    expect(agentProcess.stderr).toBe("");

    const externalVerifier = spawnSync(process.execPath, ["test.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(externalVerifier.status).toBe(0);
    expect(externalVerifier.stdout).toBe("external verifier passed\n");

    const reopenVerifierEntry = fileURLToPath(
      new URL("../../scripts/verify-m3-durable-session.mjs", import.meta.url),
    );
    const durableVerifier = spawnSync(
      process.execPath,
      [reopenVerifierEntry, reportPath, dataRoot],
      { cwd: root, encoding: "utf8", env: { ...process.env } },
    );
    expect(durableVerifier.status).toBe(0);
    expect(durableVerifier.stdout).toBe("");
    expect(durableVerifier.stderr).toBe("");

    const diff = spawnSync("git", ["diff", "--", "math.js"], { cwd: root, encoding: "utf8" });
    expect(diff.status).toBe(0);
    expect(diff.stdout).toContain("-  return a - b;");
    expect(diff.stdout).toContain("+  return a + b;");
    const evidence = JSON.parse(await readFile(reportPath, "utf8"));
    expect(evidence).toMatchObject({
      terminalTimelineCount: 1,
      report: {
        status: "completed",
        finalAnswer: "已修复加法实现，项目测试通过，Git evidence 已核验。",
        counts: {
          modelTurnCount: 8,
          modelAttemptCount: 8,
          toolCallCount: 7,
          settledToolCallCount: 7,
        },
        tools: { accepted: 7, settled: 7, succeeded: 7, failed: 0 },
        changedFiles: [{ path: "math.js", change: "modified" }],
        commands: [{ command: "bun test.mjs", exitCode: 0 }],
      },
      reopened: {
        terminalTimelineCount: 1,
        report: {
          status: "completed",
          finalAnswer: "已修复加法实现，项目测试通过，Git evidence 已核验。",
          counts: { toolCallCount: 7, settledToolCallCount: 7 },
        },
      },
    });
  });
});
