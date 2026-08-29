import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectInstructionsContextSource } from "../../src/context/index.js";
import { createBuiltInSkillSource, createSkillRegistry } from "../../src/skills/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fast-context-source-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const contextInput = {
  runId: "run-1" as never,
  modelTurnCount: 0,
  modelAttemptCount: 0,
  branch: { sessionId: "session-1", branchId: "branch-1", records: [], checkpoints: [] } as never,
  tools: [],
  signal: new AbortController().signal,
};

describe("coding ContextSource", () => {
  it("按 workspace root 到 active directory、再按 filename 顺序收集 project instructions", async () => {
    const root = await temporaryDirectory();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root agent", "utf8");
    await writeFile(join(root, "CONTEXT.md"), "root context", "utf8");
    await writeFile(join(nested, "AGENTS.md"), "nested agent", "utf8");
    const source = createProjectInstructionsContextSource({
      workspaceRoot: root,
      activeDirectory: nested,
    });

    const contributions = await source.collect(contextInput);
    expect(contributions.map((contribution) => contribution.provenance.id)).toEqual([
      "AGENTS.md",
      "CONTEXT.md",
      "packages/app/AGENTS.md",
    ]);
    expect(contributions.every((contribution) => contribution.required)).toBe(true);
    expect(
      contributions.every((contribution) => contribution.provenance.digest?.startsWith("sha256:")),
    ).toBe(true);
  });

  it("selected skills 以 manifest 所需 provenance/digest 顺序注入且只产生 instructions", async () => {
    const registry = await createSkillRegistry(
      [
        createBuiltInSkillSource([
          {
            id: "first",
            version: "1.0.0",
            description: "first skill",
            instructions: "first instructions",
            resources: { "guide.txt": "guide" },
          },
          {
            id: "second",
            version: "1.0.0",
            description: "second skill",
            instructions: "second instructions",
          },
        ]),
      ],
      { workspaceRoot: process.cwd() },
    );
    const source = registry.contextSource(registry.select({ ids: ["second", "first"] }));
    const contributions = await source.collect(contextInput);

    expect(contributions.map((contribution) => contribution.provenance.id)).toEqual([
      "second",
      "first",
    ]);
    expect(contributions[1]).toMatchObject({
      sourceId: "selected_skills",
      required: true,
      orderingGroup: "skills",
      provenance: { kind: "skill", attributes: { sourceKind: "built_in", version: "1.0.0" } },
      content: { kind: "instructions" },
    });
    expect(contributions.every((contribution) => contribution.provenance.digest)).toBe(true);
  });
});
