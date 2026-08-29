import { readFile } from "node:fs/promises";

const minimumLines = Number(process.argv[2] ?? 75);
if (!Number.isFinite(minimumLines) || minimumLines < 0 || minimumLines > 100) {
  throw new TypeError("line coverage gate 必须是 0..100");
}

const report = await readFile("coverage/lcov.info", "utf8");
let lineTotal = 0;
let lineCovered = 0;
let functionTotal = 0;
let functionCovered = 0;
let branchTotal = 0;
let branchCovered = 0;
for (const line of report.split(/\r?\n/)) {
  if (line.startsWith("LF:")) lineTotal += Number(line.slice(3));
  else if (line.startsWith("LH:")) lineCovered += Number(line.slice(3));
  else if (line.startsWith("FNF:")) functionTotal += Number(line.slice(4));
  else if (line.startsWith("FNH:")) functionCovered += Number(line.slice(4));
  else if (line.startsWith("BRF:")) branchTotal += Number(line.slice(4));
  else if (line.startsWith("BRH:")) branchCovered += Number(line.slice(4));
}
if (lineTotal === 0) throw new Error("Bun LCOV report 没有 production line evidence");
const lines = (lineCovered / lineTotal) * 100;
const functions = functionTotal === 0 ? 100 : (functionCovered / functionTotal) * 100;
const branches = branchTotal === 0 ? undefined : (branchCovered / branchTotal) * 100;
process.stdout.write(
  `Bun production coverage: lines ${lines.toFixed(2)}%, functions ${functions.toFixed(2)}%, ` +
    `branches ${branches === undefined ? "not emitted by Bun 1.4.0" : `${branches.toFixed(2)}%`}\n`,
);
if (lines < minimumLines) {
  throw new Error(`line coverage 未达到 ${minimumLines}% gate`);
}
