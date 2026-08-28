import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const forbidden = /TODO|FIXME|NotImplemented|not implemented/i;
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "packages/*/src/**"],
  {
    encoding: "utf8",
    windowsHide: true,
  },
)
  .split(/\r?\n/)
  .filter((file) => file.length > 0 && existsSync(file));
const findings = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  text.split(/\r?\n/).forEach((line, index) => {
    if (forbidden.test(line)) findings.push(`${file}:${index + 1}:${line.trim()}`);
  });
}
if (findings.length > 0) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Production readiness scan passed (${files.length} tracked source files).\n`,
  );
}
