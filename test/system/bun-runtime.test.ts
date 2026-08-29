import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectBunRuntime,
  supportedBunVersion,
} from "../../packages/coding/src/runtime/bun-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10 })),
  );
});

describe("Bun runtime policy", () => {
  it("reports the pinned runtime version and native target", () => {
    expect(detectBunRuntime()).toMatchObject({
      runtime: "bun",
      version: supportedBunVersion,
      platform: process.platform,
      architecture: process.arch,
      supported: true,
    });
  });

  it("production CLI exposes a machine-readable startup diagnostic", () => {
    const result = spawnSync(
      process.execPath,
      ["--no-env-file", "packages/coding/src/cli/entry.ts", "--runtime-diagnostic"],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env } },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      runtime: "bun",
      version: supportedBunVersion,
      platform: process.platform,
      architecture: process.arch,
      supported: true,
    });
  });

  it("bunfig disables implicit workspace .env loading", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "coding-agent-bun-env-"));
    temporaryDirectories.push(root);
    const policy = await readFile(path.join(process.cwd(), "bunfig.toml"), "utf8");
    expect(policy).toContain("env = false");
    // Isolate the env policy under test. Copying the workspace preload entries
    // would require this temporary directory to resolve production dependencies.
    await writeFile(path.join(root, "bunfig.toml"), "env = false\n", "utf8");
    await writeFile(path.join(root, ".env"), "M51_ENV_CANARY=must-not-load\n", "utf8");
    await writeFile(
      path.join(root, "probe.ts"),
      'process.stdout.write(process.env.M51_ENV_CANARY ?? "<missing>");\n',
      "utf8",
    );
    const result = spawnSync(process.execPath, ["probe.ts"], {
      cwd: root,
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name !== "M51_ENV_CANARY"),
      ),
    });
    expect(
      result.status,
      `probe failed: ${JSON.stringify({ error: result.error, stdout: result.stdout, stderr: result.stderr })}`,
    ).toBe(0);
    expect(result.stdout).toBe("<missing>");
    expect(result.stderr).toBe("");
  });
});
