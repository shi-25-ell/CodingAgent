import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputDirectory = path.join(root, "artifacts", "m51");
const pinnedVersion = (await readFile(path.join(root, ".bun-version"), "utf8")).trim();
if (Bun.version !== pinnedVersion) {
  throw new Error(`release build 需要 Bun ${pinnedVersion}，实际为 ${Bun.version}`);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const entrypoint = path.join(root, "packages", "coding", "src", "cli", "entry.ts");
const bundle = await Bun.build({
  entrypoints: [entrypoint],
  outdir: outputDirectory,
  naming: "m51-cli-bundle.js",
  target: "bun",
  format: "esm",
  packages: "bundle",
  conditions: ["bun", "import"],
  env: "disable",
  sourcemap: "linked",
  splitting: false,
  minify: false,
});
if (!bundle.success) {
  for (const log of bundle.logs) console.error(log);
  throw new Error("Bun release bundle build 失败");
}

const executableBase = path.join(outputDirectory, "m51-cli-executable");
const executable = await Bun.build({
  entrypoints: [entrypoint],
  target: "bun",
  format: "esm",
  packages: "bundle",
  conditions: ["bun", "import"],
  env: "disable",
  minify: false,
  compile: {
    outfile: executableBase,
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
});
if (!executable.success) {
  for (const log of executable.logs) console.error(log);
  throw new Error("Bun standalone executable build 失败");
}

async function describe(file) {
  const bytes = await Bun.file(file).arrayBuffer();
  return {
    file: path.relative(root, file).replaceAll(path.sep, "/"),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
  };
}

const bundlePath = path.join(outputDirectory, "m51-cli-bundle.js");
const executablePath =
  executable.outputs.find((output) => output.kind === "entry-point")?.path ??
  (process.platform === "win32" ? `${executableBase}.exe` : executableBase);
const manifest = {
  schemaVersion: 1,
  workingIdentifier: "m51-cli",
  runtime: {
    name: "bun",
    version: Bun.version,
    revision: Bun.revision,
    platform: process.platform,
    architecture: process.arch,
  },
  sourceEntrypoint: "packages/coding/src/cli/entry.ts",
  packageConditions: ["bun", "import"],
  bundlePolicy: {
    target: "bun",
    format: "esm",
    packages: "bundle",
    sourceMap: "linked",
    dynamicSpecifiers: "preserved for the future trusted local extension loader",
  },
  executablePolicy: {
    role: "M5.1 compatibility evidence; the JS bundle remains the extension-safe release path",
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  license: "UNLICENSED private workspace; no license file is distributed",
  futureNativeTargets: ["bun-windows-x64", "bun-linux-x64", "bun-linux-arm64"],
  artifacts: [
    await describe(bundlePath),
    await describe(`${bundlePath}.map`),
    await describe(executablePath),
  ],
};
await writeFile(
  path.join(outputDirectory, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `Built M5.1 release evidence for Bun ${Bun.version} ${process.platform}/${process.arch}.\n`,
);
