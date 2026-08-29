import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDexRunConfiguration } from "../../src/cli/config-loader.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Dex config loader", () => {
  it("按 defaults < user < project < environment < CLI 合并 validated Run configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dex-config-"));
    const data = await mkdtemp(path.join(os.tmpdir(), "dex-data-"));
    temporaryRoots.push(root, data);
    await mkdir(path.join(root, ".dex"));
    await writeFile(
      path.join(data, "config.json"),
      JSON.stringify({ provider: "openrouter", maxModelTurns: 3, tools: ["read_file"] }),
    );
    await writeFile(
      path.join(root, ".dex", "config.json"),
      JSON.stringify({ maxModelTurns: 5, permissionMode: "safe", skills: ["project"] }),
    );

    const resolved = await resolveDexRunConfiguration({
      workspaceRoot: root,
      environment: {
        DEX_DATA_HOME: data,
        DEX_MODEL_PROVIDER: "glm",
        DEX_GLM_MODEL: "glm-env",
        DEX_MAX_MODEL_TURNS: "7",
      },
      overrides: { model: "glm-cli", maxModelTurns: 9, structured: true },
    });

    expect(resolved).toEqual({
      provider: "glm",
      model: "glm-cli",
      permissionMode: "safe",
      maxModelTurns: 9,
      tools: ["read_file"],
      skills: ["project"],
      structured: true,
    });
  });

  it("拒绝未知字段和非法 environment 值", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dex-config-invalid-"));
    const data = await mkdtemp(path.join(os.tmpdir(), "dex-data-invalid-"));
    temporaryRoots.push(root, data);
    await writeFile(path.join(data, "config.json"), JSON.stringify({ secret: "no" }));
    await expect(
      resolveDexRunConfiguration({
        workspaceRoot: root,
        environment: { DEX_DATA_HOME: data },
        overrides: { structured: false },
      }),
    ).rejects.toThrow(/未知字段/);
  });
});
