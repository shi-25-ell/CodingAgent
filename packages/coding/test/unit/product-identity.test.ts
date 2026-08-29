import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectLegacyProductConfiguration,
  productEnvironment,
  productIdentity,
} from "../../src/product/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("product identity", () => {
  it("将品牌 surface 与技术 namespace 分离", () => {
    expect(productIdentity).toMatchObject({
      displayName: "Dex Code",
      executable: "dex",
      environmentPrefix: "DEX_",
      projectDirectoryName: ".dex",
      packageScope: "@coding-agent",
      extensionNamespace: "coding-agent",
    });
    expect(productEnvironment.modelProvider).toBe("DEX_MODEL_PROVIDER");
  });

  it("拒绝静默读取旧 environment namespace", () => {
    const previous = process.env.FAST_MODEL_PROVIDER;
    try {
      process.env.FAST_MODEL_PROVIDER = "openai";
      expect(detectLegacyProductConfiguration("D:/work/demo")).toBe(
        "检测到旧工作标识 FAST_MODEL_PROVIDER；请改用 DEX_MODEL_PROVIDER。Dex Code 不会静默读取旧环境变量。",
      );
    } finally {
      if (previous === undefined) delete process.env.FAST_MODEL_PROVIDER;
      else process.env.FAST_MODEL_PROVIDER = previous;
    }
  });

  it("旧 project directory 只在尚未迁移时产生诊断", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "dex-product-identity-"));
    temporaryDirectories.push(workspace);
    await mkdir(path.join(workspace, ".fast"));

    expect(detectLegacyProductConfiguration(workspace)).toContain("请迁移为");

    await mkdir(path.join(workspace, ".dex"));
    expect(detectLegacyProductConfiguration(workspace)).toBeUndefined();
  });
});
