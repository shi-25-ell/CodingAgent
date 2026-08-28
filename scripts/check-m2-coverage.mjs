import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const baseline = process.argv[2] ?? process.env.M2_COVERAGE_BASE ?? "m1";
const milestone = process.argv[3] ?? "changed production";
const diff = execFileSync(
  "git",
  ["diff", "--unified=0", "--diff-filter=AM", baseline, "--", "packages/*/src/**/*.ts"],
  { encoding: "utf8" },
);
const changedLines = new Map();
let currentFile;
for (const line of diff.split(/\r?\n/)) {
  if (line.startsWith("+++ b/")) {
    currentFile = path.resolve(line.slice(6));
    changedLines.set(currentFile, new Set());
    continue;
  }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!hunk || !currentFile) continue;
  const start = Number(hunk[1]);
  const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
  const lines = changedLines.get(currentFile);
  for (let offset = 0; offset < count; offset += 1) lines.add(start + offset);
}

const coverage = JSON.parse(readFileSync("coverage/coverage-final.json", "utf8"));
const entries = new Map(
  Object.entries(coverage).map(([file, evidence]) => [path.resolve(file).toLowerCase(), evidence]),
);
const missingRuntimeCoverage = [];
const lineHits = new Map();
let branchTotal = 0;
let branchCovered = 0;
let runtimeFiles = 0;

for (const [file, additions] of changedLines) {
  if (additions.size === 0) continue;
  const evidence = entries.get(file.toLowerCase());
  if (!evidence) {
    const emitted = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const runtimeText = emitted.replace(/export\s*\{\s*\};?/g, "").trim();
    if (runtimeText.length > 0) missingRuntimeCoverage.push(path.relative(process.cwd(), file));
    continue;
  }
  runtimeFiles += 1;
  for (const [statementId, location] of Object.entries(evidence.statementMap)) {
    const count = evidence.s[statementId];
    for (let line = location.start.line; line <= location.end.line; line += 1) {
      if (!additions.has(line)) continue;
      const key = `${file}:${line}`;
      lineHits.set(key, Math.max(lineHits.get(key) ?? 0, count));
    }
  }
  for (const [branchId, branch] of Object.entries(evidence.branchMap)) {
    const touchesAddition = [branch.loc, ...branch.locations].some((location) => {
      for (let line = location.start.line; line <= location.end.line; line += 1) {
        if (additions.has(line)) return true;
      }
      return false;
    });
    if (!touchesAddition) continue;
    const counts = evidence.b[branchId];
    branchTotal += counts.length;
    branchCovered += counts.filter((count) => count > 0).length;
  }
}

if (missingRuntimeCoverage.length > 0) {
  throw new Error(
    `新增 runtime production files 缺少 coverage summary: ${missingRuntimeCoverage.join(", ")}`,
  );
}
if (lineHits.size === 0) throw new Error(`${baseline} 之后没有可核验的新增 production lines`);
const coveredLines = [...lineHits.values()].filter((count) => count > 0).length;
const lines = (coveredLines / lineHits.size) * 100;
const branches = branchTotal === 0 ? 100 : (branchCovered / branchTotal) * 100;
console.log(
  `${milestone} added production coverage (${runtimeFiles} runtime files, ${lineHits.size} executable lines, ${branchTotal} branches): lines ${lines.toFixed(2)}%, branches ${branches.toFixed(2)}%`,
);
if (lines < 85 || branches < 80) {
  throw new Error(`${milestone} added production coverage 未达到 lines 85% / branches 80% gate`);
}
