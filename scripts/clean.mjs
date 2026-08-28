import { rm } from "node:fs/promises";

const targets = ["packages/model/dist", "packages/agent/dist", "packages/coding/dist"];
await Promise.all(targets.map((target) => rm(target, { force: true, recursive: true })));
