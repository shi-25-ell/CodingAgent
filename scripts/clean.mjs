import { rm } from "node:fs/promises";

const targets = [
  "packages/model/dist",
  "packages/agent/dist",
  "packages/sqlite/dist",
  "packages/coding/dist",
  "artifacts/m51",
  "coverage",
];
await Promise.all(targets.map((target) => rm(target, { force: true, recursive: true })));
