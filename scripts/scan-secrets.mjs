import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  encoding: "utf8",
});
if (listed.status !== 0) {
  process.stderr.write(listed.stderr || "git ls-files failed\n");
  process.exit(1);
}

const patterns = [
  ["private-key", new RegExp("BEGIN " + "(?:RSA |EC |OPENSSH )?" + "PRIVATE KEY")],
  ["aws-access-key", new RegExp("AKIA" + "[0-9A-Z]{16}")],
  ["provider-token", new RegExp("sk-" + "[A-Za-z0-9_-]{16,}")],
];
const findings = [];

for (const file of listed.stdout.split("\0").filter(Boolean)) {
  const bytes = await readFile(file);
  if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) continue;
  const lines = bytes.toString("utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const [label, pattern] of patterns) {
      if (pattern.test(line)) findings.push(`${file}:${index + 1}: ${label}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`credential-shaped values found:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("secret scan: pass\n");
}
