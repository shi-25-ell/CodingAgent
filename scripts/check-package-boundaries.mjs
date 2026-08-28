import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const packagesRoot = path.join(workspaceRoot, "packages");
const targetPackages = ["model", "agent", "coding", "sqlite"];
const allowed = {
  model: new Set(),
  agent: new Set(["model"]),
  sqlite: new Set(["agent"]),
  coding: new Set(["model", "agent", "sqlite"]),
};
const publicSubpaths = {
  model: new Set(["testing", "auth", "providers/openai-compatible"]),
  agent: new Set(["session", "context", "testing"]),
  sqlite: new Set(),
  coding: new Set(["print", "testing"]),
};

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return filesUnder(target);
      return /\.[cm]?[jt]sx?$/.test(entry.name) ? [target] : [];
    }),
  );
  return nested.flat();
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const packageDirectories = (await readdir(packagesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const violations = [];
const dependencyGraph = new Map();

for (const directory of packageDirectories) {
  if (!targetPackages.includes(directory)) {
    violations.push(
      `packages/${directory}: 只允许 model、agent、coding、sqlite 四个 production packages`,
    );
    continue;
  }

  const packageRoot = path.join(packagesRoot, directory);
  const sourceDirectory = path.join(packageRoot, "src");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const expectedName = `@coding-agent/${directory}`;
  if (manifest.name !== expectedName) {
    violations.push(`packages/${directory}/package.json: package name 必须是 ${expectedName}`);
  }

  const files = await filesUnder(sourceDirectory);
  if (files.length === 0) {
    violations.push(`packages/${directory}: 不允许没有真实 source implementation 的空 package`);
  }

  const dependencies = Object.keys(manifest.dependencies ?? {});
  const internalDependencies = dependencies
    .filter((name) => name.startsWith("@coding-agent/"))
    .map((name) => name.slice("@coding-agent/".length));
  dependencyGraph.set(directory, internalDependencies);
  for (const dependency of internalDependencies) {
    if (!allowed[directory].has(dependency)) {
      violations.push(`packages/${directory}/package.json: 禁止依赖 @coding-agent/${dependency}`);
    }
  }

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const imports = source.matchAll(/(?:from\s+|import\s*\()(["'])(@coding-agent\/([^"']+))\1/g);
    for (const match of imports) {
      const specifier = match[2];
      const [dependency, ...segments] = match[3].split("/");
      if (dependency === directory) {
        violations.push(
          `${path.relative(workspaceRoot, file)}: package 内禁止经 public index 自引用 ${specifier}`,
        );
        continue;
      }
      if (!allowed[directory].has(dependency)) {
        violations.push(
          `${path.relative(workspaceRoot, file)}: ${directory} 禁止 import ${specifier}`,
        );
      }
      if (!dependencies.includes(`@coding-agent/${dependency}`)) {
        violations.push(`${path.relative(workspaceRoot, file)}: manifest 未声明 ${specifier}`);
      }
      const subpath = segments.join("/");
      if (segments.length > 0 && !publicSubpaths[dependency]?.has(subpath)) {
        violations.push(
          `${path.relative(workspaceRoot, file)}: deep 或未声明的 package import ${specifier}`,
        );
      }
      const testingDirectory = `${path.sep}src${path.sep}testing${path.sep}`;
      if (subpath === "testing" && !file.includes(testingDirectory)) {
        violations.push(
          `${path.relative(workspaceRoot, file)}: production source 禁止依赖 testing Adapter`,
        );
      }
    }

    const relativeImports = source.matchAll(/(?:from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/g);
    for (const match of relativeImports) {
      const resolved = path.resolve(path.dirname(file), match[2]);
      if (!isWithin(resolved, sourceDirectory)) {
        violations.push(
          `${path.relative(workspaceRoot, file)}: relative import 越过 package source seam`,
        );
      }
    }
  }
}

function visit(packageName, visiting = new Set(), visited = new Set()) {
  if (visiting.has(packageName)) {
    violations.push(
      `package dependency graph 存在循环: ${[...visiting, packageName].join(" -> ")}`,
    );
    return;
  }
  if (visited.has(packageName)) return;
  visiting.add(packageName);
  for (const dependency of dependencyGraph.get(packageName) ?? []) {
    if (dependencyGraph.has(dependency)) visit(dependency, visiting, visited);
  }
  visiting.delete(packageName);
  visited.add(packageName);
}

for (const packageName of packageDirectories) visit(packageName);

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${packageDirectories.length} implemented packages against all four target dependency rules.`,
  );
}
