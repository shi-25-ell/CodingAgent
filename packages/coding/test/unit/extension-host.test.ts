import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createExtensionHost } from "../../src/extensions/host.js";

const sample = path.resolve("examples/sample-extension");

describe("ExtensionHost", () => {
  it("只加载显式启用 extension，并产生 immutable startup snapshot 和 clean disable", async () => {
    const disabled = await createExtensionHost({
      sources: [{ kind: "explicit", path: sample }],
      enabled: [],
    });
    expect(disabled.snapshot().extensions).toHaveLength(0);
    expect(disabled.diagnostics().map((item) => item.code)).toContain("EXTENSION_NOT_ENABLED");
    await disabled[Symbol.asyncDispose]();

    const host = await createExtensionHost({
      sources: [{ kind: "explicit", path: sample }],
      enabled: ["dex.sample"],
    });
    const startup = host.snapshot();
    expect(startup.extensions.map((item) => item.manifest.id)).toEqual(["dex.sample"]);
    expect(startup.tools.map((item) => item.definition.name)).toEqual(["sample_echo"]);
    expect(startup.skillSources.map((item) => item.id)).toEqual(["dex-sample-skills"]);
    expect(Object.isFrozen(startup)).toBe(true);
    expect(await host.disable("dex.sample")).toBe(true);
    expect(host.snapshot().tools).toHaveLength(0);
    expect(startup.tools).toHaveLength(1);
    await host[Symbol.asyncDispose]();
  });

  it("load failure 原子回滚已完成 registrations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dex-extension-"));
    try {
      const bundle = path.join(root, "broken");
      await mkdir(bundle);
      await writeFile(
        path.join(bundle, "coding-agent.extension.json"),
        JSON.stringify({
          schemaVersion: 1,
          namespace: "coding-agent",
          id: "broken.extension",
          version: "1.0.0",
          apiVersion: "1.0.0",
          entry: "index.js",
          capabilities: ["command"],
        }),
      );
      await writeFile(
        path.join(bundle, "index.js"),
        `export default api => { api.registerCommand({id:"half",title:"Half",kind:"cli"}); throw new Error("secret detail"); };`,
      );
      const host = await createExtensionHost({
        sources: [{ kind: "explicit", path: bundle }],
        enabled: ["broken.extension"],
        redact: (value) => value.replaceAll("secret", "[REDACTED]"),
      });
      expect(host.snapshot().commands).toHaveLength(0);
      expect(host.diagnostics().map((item) => item.code)).toEqual([
        "EXTENSION_LOAD_FAILED",
        "EXTENSION_REGISTRATION_ROLLED_BACK",
      ]);
      expect(host.diagnostics()[0]?.message).not.toContain("secret");
      await host[Symbol.asyncDispose]();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
