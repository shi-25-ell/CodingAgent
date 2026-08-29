import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputDirectory = path.join(root, "artifacts", "m51");
const manifest = JSON.parse(
  await readFile(path.join(outputDirectory, "release-manifest.json"), "utf8"),
);

function run(executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    windowsHide: true,
  });
}

const source = run(process.execPath, [
  "--no-env-file",
  "packages/coding/src/cli/entry.ts",
  "--runtime-diagnostic",
]);
const packageBin = run(process.execPath, [
  "--no-env-file",
  "run",
  "coding-agent",
  "--runtime-diagnostic",
]);
const bundle = run(process.execPath, [
  "--no-env-file",
  path.join(outputDirectory, "m51-cli-bundle.js"),
  "--runtime-diagnostic",
]);
const executableArtifact = manifest.artifacts.find((artifact) =>
  artifact.file.includes("m51-cli-executable"),
);
if (!executableArtifact) throw new Error("release manifest 缺少 executable artifact");
const executable = run(path.join(root, executableArtifact.file), ["--runtime-diagnostic"]);

for (const [name, result] of [
  ["source", source],
  ["package-bin", packageBin],
  ["bundle", bundle],
  ["executable", executable],
]) {
  if (result.status !== 0 || result.stderr !== "") {
    throw new Error(`${name} runtime smoke 失败: status=${result.status} stderr=${result.stderr}`);
  }
}

const diagnostics = [source, packageBin, bundle, executable].map((result) =>
  JSON.parse(result.stdout),
);
for (const diagnostic of diagnostics) {
  if (
    diagnostic.runtime !== "bun" ||
    diagnostic.version !== manifest.runtime.version ||
    diagnostic.platform !== manifest.runtime.platform ||
    diagnostic.architecture !== manifest.runtime.architecture ||
    diagnostic.supported !== true
  ) {
    throw new Error(`release runtime diagnostic 不一致: ${JSON.stringify(diagnostic)}`);
  }
}

const invalidProviderEnvironment = {
  FAST_MODEL_PROVIDER: "m51-invalid-provider",
};
const sourceFailure = run(
  process.execPath,
  ["--no-env-file", "packages/coding/src/cli/entry.ts", "--print", "smoke"],
  { env: invalidProviderEnvironment },
);
const bundleFailure = run(
  process.execPath,
  ["--no-env-file", path.join(outputDirectory, "m51-cli-bundle.js"), "--print", "smoke"],
  { env: invalidProviderEnvironment },
);
const executableFailure = run(path.join(root, executableArtifact.file), ["--print", "smoke"], {
  env: invalidProviderEnvironment,
});
for (const result of [sourceFailure, bundleFailure, executableFailure]) {
  if (result.status !== 2 || !result.stderr.includes("不支持的 model provider")) {
    throw new Error(
      `production composition failure parity 不一致: status=${result.status} stderr=${result.stderr}`,
    );
  }
}

process.stdout.write(
  `Release smoke passed: source, package bin, bundle and executable on ${manifest.runtime.platform}/${manifest.runtime.architecture}.\n`,
);
