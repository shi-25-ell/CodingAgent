import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const baseline = process.env.M2_COVERAGE_BASE ?? "m1";
const changedFiles = execFileSync(
  "git",
  ["diff", "--name-only", "--diff-filter=AM", baseline, "--", "packages/*/src/**/*.ts"],
  { encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter(Boolean)
  .map((file) => path.resolve(file));
const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
const normalizedEntries = new Map(
  Object.entries(summary)
    .filter(([file]) => file !== "total")
    .map(([file, metrics]) => [path.resolve(file).toLowerCase(), metrics]),
);
const covered = changedFiles
  .map((file) => normalizedEntries.get(file.toLowerCase()))
  .filter(Boolean);

if (covered.length === 0) {
  throw new Error(`未找到 ${baseline} 之后新增或修改 production code 的 coverage evidence`);
}

const aggregate = (metric) => {
  const total = covered.reduce((sum, entry) => sum + entry[metric].total, 0);
  const count = covered.reduce((sum, entry) => sum + entry[metric].covered, 0);
  return total === 0 ? 100 : (count / total) * 100;
};
const lines = aggregate("lines");
const branches = aggregate("branches");
console.log(
  `M2 changed production coverage (${covered.length} executable files): lines ${lines.toFixed(2)}%, branches ${branches.toFixed(2)}%`,
);
if (lines < 85 || branches < 80) {
  throw new Error("M2 changed production coverage 未达到 lines 85% / branches 80% gate");
}
