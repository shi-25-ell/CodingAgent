import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const workspace = process.cwd();
const productionRoots = ["application", "model", "runtime", "session"];
const forbiddenTargets = new Map([
  ["application", new Set(["testing"])],
  ["model", new Set(["application", "runtime", "session", "testing"])],
  ["runtime", new Set(["application", "session", "testing"])],
  ["session", new Set(["application", "runtime", "testing"])],
]);
const violations = [];

for (const sourceRoot of productionRoots) {
  for (const file of await typescriptFiles(path.join(workspace, sourceRoot))) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === undefined || !specifier.startsWith(".")) continue;
      const target = path.relative(workspace, path.resolve(path.dirname(file), specifier));
      const targetRoot = target.split(path.sep)[0];
      if (targetRoot !== undefined && forbiddenTargets.get(sourceRoot)?.has(targetRoot)) {
        violations.push(`${path.relative(workspace, file)} -> ${specifier}`);
      }
    }
  }
}

for (const universalDirectory of ["shared", "common"]) {
  try {
    await readdir(path.join(workspace, universalDirectory));
    violations.push(`${universalDirectory}/ is prohibited by the production code layout`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (violations.length > 0) {
  process.stderr.write(`dependency boundary violations:\n${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("dependency boundaries: pass\n");
}

async function typescriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptFiles(entryPath)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
  }
  return files;
}
