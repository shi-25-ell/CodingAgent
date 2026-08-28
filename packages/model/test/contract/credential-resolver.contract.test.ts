import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCredentialResolver,
  createEnvironmentCredentialSource,
  createLocalConfigCredentialSource,
  credentialRef,
} from "../../src/auth/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CredentialResolver", () => {
  it("credential source 校验 id，并稳定处理 unmapped、missing file 与 missing key", async () => {
    expect(() => createEnvironmentCredentialSource({ id: " ", values: {}, variables: {} })).toThrow(
      "id",
    );
    expect(() => createLocalConfigCredentialSource({ id: " ", path: "unused" })).toThrow("id");

    const request = { ref: credentialRef("openai.default"), kind: "bearer" as const };
    const environment = createEnvironmentCredentialSource({
      id: "environment",
      values: {},
      variables: { "other.default": "OTHER_API_KEY", "openai.default": "OPENAI_API_KEY" },
    });
    await expect(environment.resolve(request)).resolves.toEqual({ status: "missing" });
    await expect(
      environment.resolve({ ...request, ref: credentialRef("unmapped.default") }),
    ).resolves.toEqual({ status: "missing" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      environment.resolve(request, { signal: controller.signal }),
    ).resolves.toMatchObject({ status: "failed", failure: { category: "cancelled" } });

    const directory = await mkdtemp(path.join(tmpdir(), "fast-auth-missing-"));
    temporaryDirectories.push(directory);
    const missingPath = path.join(directory, "missing.json");
    const local = createLocalConfigCredentialSource({ id: "local", path: missingPath });
    await expect(local.resolve(request)).resolves.toEqual({ status: "missing" });
    await writeFile(missingPath, "{}", "utf8");
    await expect(local.resolve(request)).resolves.toEqual({ status: "missing" });
    await writeFile(missingPath, JSON.stringify({ "openai.default": "" }), "utf8");
    await expect(local.resolve(request)).resolves.toMatchObject({
      status: "failed",
      failure: { category: "failed" },
    });
    await writeFile(missingPath, JSON.stringify({ "openai.default": "local-secret" }), "utf8");
    await expect(
      local.resolve(request, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ status: "found", sourceId: "local" });
    await expect(local.resolve(request, { signal: controller.signal })).resolves.toMatchObject({
      status: "failed",
      failure: { category: "cancelled" },
    });
  });

  it("按 source 顺序解析、每次读取最新环境值，并保持 SecretString 脱敏", async () => {
    const values: Record<string, string | undefined> = {};
    const source = createEnvironmentCredentialSource({
      id: "environment",
      values,
      variables: { "openai.default": "FAST_OPENAI_API_KEY" },
    });
    const resolver = createCredentialResolver([source]);
    const request = {
      ref: credentialRef("openai.default"),
      kind: "bearer" as const,
    };

    await expect(resolver.resolve(request)).resolves.toEqual({ status: "missing" });

    values.FAST_OPENAI_API_KEY = "first-secret";
    const first = await resolver.resolve(request);
    expect(first).toMatchObject({ status: "found", sourceId: "environment" });
    if (first.status !== "found") throw new Error("credential 未解析");
    expect(first.credential.value.reveal()).toBe("first-secret");
    expect(String(first.credential.value)).toBe("[REDACTED]");
    expect(JSON.stringify(first)).not.toContain("first-secret");

    values.FAST_OPENAI_API_KEY = "rotated-secret";
    const rotated = await resolver.resolve(request);
    if (rotated.status !== "found") throw new Error("rotated credential 未解析");
    expect(rotated.credential.value.reveal()).toBe("rotated-secret");
  });

  it("environment 优先于 ignored local config，并明确返回 config failure 与 cancelled", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fast-auth-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "credentials.json");
    await writeFile(configPath, JSON.stringify({ "openai.default": "config-secret" }), "utf8");
    const values: Record<string, string | undefined> = {};
    const resolver = createCredentialResolver([
      createEnvironmentCredentialSource({
        id: "environment",
        values,
        variables: { "openai.default": "FAST_OPENAI_API_KEY" },
      }),
      createLocalConfigCredentialSource({ id: "local-config", path: configPath }),
    ]);
    const request = { ref: credentialRef("openai.default"), kind: "bearer" as const };

    const fromConfig = await resolver.resolve(request);
    expect(fromConfig).toMatchObject({ status: "found", sourceId: "local-config" });

    values.FAST_OPENAI_API_KEY = "environment-secret";
    const fromEnvironment = await resolver.resolve(request);
    expect(fromEnvironment).toMatchObject({ status: "found", sourceId: "environment" });

    values.FAST_OPENAI_API_KEY = undefined;
    await writeFile(configPath, "[]", "utf8");
    await expect(resolver.resolve(request)).resolves.toEqual({
      status: "failed",
      failure: { category: "failed", message: "Local credential config 无效" },
    });

    const controller = new AbortController();
    controller.abort();
    await expect(resolver.resolve(request, { signal: controller.signal })).resolves.toEqual({
      status: "failed",
      failure: { category: "cancelled", message: "Credential resolution 已取消" },
    });
  });
});
