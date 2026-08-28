import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBuiltInSkillSource,
  createDirectorySkillSource,
  createSkillRegistry,
  SkillConflictError,
} from "../../src/skills/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fast-skill-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSkill(
  root: string,
  folder: string,
  input: {
    readonly id: string;
    readonly instructions: string;
    readonly extraMetadata?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const directory = join(root, folder);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "skill.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: input.id,
      version: "1.2.3",
      description: `${input.id} description`,
      instructions: "SKILL.md",
      resources: ["references/example.txt"],
      ...input.extraMetadata,
    }),
    "utf8",
  );
  await mkdir(join(directory, "references"));
  await writeFile(join(directory, "SKILL.md"), input.instructions, "utf8");
  await writeFile(join(directory, "references", "example.txt"), "resource", "utf8");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("SkillRegistry", () => {
  it("按 project > user > built-in precedence 合并并保留 shadow diagnostic", async () => {
    const userRoot = await temporaryDirectory();
    const projectRoot = await temporaryDirectory();
    await writeSkill(userRoot, "review", { id: "review", instructions: "user instructions" });
    await writeSkill(projectRoot, "review", {
      id: "review",
      instructions: "project instructions",
    });
    const registry = await createSkillRegistry(
      [
        createBuiltInSkillSource([
          {
            id: "review",
            version: "1.0.0",
            description: "built-in review",
            instructions: "built-in instructions",
          },
        ]),
        createDirectorySkillSource({ id: "user-a", kind: "user", directory: userRoot }),
        createDirectorySkillSource({ id: "project-a", kind: "project", directory: projectRoot }),
      ],
      { workspaceRoot: projectRoot },
    );

    expect(registry.resolve("review").provenance.sourceKind).toBe("project");
    expect(registry.diagnostics()).toHaveLength(2);
    const refs = registry.select({ ids: ["review"] });
    const reviewRef = refs[0];
    if (!reviewRef) throw new Error("review skill ref 缺失");
    expect(await registry.load(reviewRef)).toMatchObject({ instructions: "project instructions" });
  });

  it("同 precedence 的重复 ID 显式冲突", async () => {
    const first = await temporaryDirectory();
    const second = await temporaryDirectory();
    await writeSkill(first, "same", { id: "same", instructions: "first" });
    await writeSkill(second, "same", { id: "same", instructions: "second" });

    await expect(
      createSkillRegistry(
        [
          createDirectorySkillSource({ id: "user-first", kind: "user", directory: first }),
          createDirectorySkillSource({ id: "user-second", kind: "user", directory: second }),
        ],
        { workspaceRoot: first },
      ),
    ).rejects.toBeInstanceOf(SkillConflictError);
  });

  it("strict metadata 拒绝未知字段且 load 检测 discovery 后内容变化", async () => {
    const invalidRoot = await temporaryDirectory();
    await writeSkill(invalidRoot, "invalid", {
      id: "invalid",
      instructions: "invalid",
      extraMetadata: { unsupported: true },
    });
    await expect(
      createSkillRegistry(
        [
          createDirectorySkillSource({
            id: "invalid-source",
            kind: "project",
            directory: invalidRoot,
          }),
        ],
        { workspaceRoot: invalidRoot },
      ),
    ).rejects.toThrowError(/未知字段/);

    const mutableRoot = await temporaryDirectory();
    await writeSkill(mutableRoot, "mutable", { id: "mutable", instructions: "before" });
    const registry = await createSkillRegistry(
      [
        createDirectorySkillSource({
          id: "mutable-source",
          kind: "project",
          directory: mutableRoot,
        }),
      ],
      { workspaceRoot: mutableRoot },
    );
    const ref = registry.select({ ids: ["mutable"] })[0];
    if (!ref) throw new Error("mutable skill ref 缺失");
    await writeFile(join(mutableRoot, "mutable", "SKILL.md"), "after", "utf8");
    await expect(registry.load(ref)).rejects.toThrowError(/发生变化/);
  });

  it("selection 保留显式顺序并拒绝 duplicate/unknown ID", async () => {
    const registry = await createSkillRegistry(
      [
        createBuiltInSkillSource([
          { id: "alpha", version: "1.0.0", description: "alpha", instructions: "alpha" },
          { id: "beta", version: "1.0.0", description: "beta", instructions: "beta" },
        ]),
      ],
      { workspaceRoot: process.cwd() },
    );
    expect(registry.select({ ids: ["beta", "alpha"] }).map((ref) => ref.id)).toEqual([
      "beta",
      "alpha",
    ]);
    expect(() => registry.select({ ids: ["alpha", "alpha"] })).toThrowError(/重复/);
    expect(() => registry.select({ ids: ["missing"] })).toThrowError(/未知/);
  });
});
