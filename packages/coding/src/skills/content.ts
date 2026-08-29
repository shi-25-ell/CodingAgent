import { createHash } from "node:crypto";
import type { SkillResource, SkillSourceKind } from "./contracts.js";
import { SkillValidationError } from "./contracts.js";

const idPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ValidatedSkillMetadata {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly instructions: string;
  readonly resources: readonly string[];
}

export function compareSkillText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validateSourceId(value: string): void {
  if (!idPattern.test(value)) {
    throw new SkillValidationError(`Skill source ID 无效: ${value}`);
  }
}

export function validateSkillIdentity(id: string, version: string, description: string): void {
  if (!idPattern.test(id)) throw new SkillValidationError(`Skill ID 无效: ${id}`);
  if (!semverPattern.test(version)) {
    throw new SkillValidationError(`Skill ${id} version 必须是 SemVer`);
  }
  if (description.trim().length === 0 || description.length > 500) {
    throw new SkillValidationError(`Skill ${id} description 必须为 1-500 个字符`);
  }
}

export function validateRelativeFile(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SkillValidationError(`${field} 必须是非空相对路径`);
  }
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new SkillValidationError(`${field} 必须使用 bundle 内 POSIX 相对路径`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new SkillValidationError(`${field} 不能包含空段、. 或 ..`);
  }
  return value;
}

export function validateSkillMetadata(value: unknown): ValidatedSkillMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SkillValidationError("skill.json 必须是 object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "id",
    "version",
    "description",
    "instructions",
    "resources",
  ]);
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new SkillValidationError(`skill.json 包含未知字段: ${extra.sort().join(", ")}`);
  }
  if (record.schemaVersion !== 1) {
    throw new SkillValidationError("skill.json schemaVersion 必须为 1");
  }
  if (
    typeof record.id !== "string" ||
    typeof record.version !== "string" ||
    typeof record.description !== "string"
  ) {
    throw new SkillValidationError("skill.json id/version/description 必须是 string");
  }
  validateSkillIdentity(record.id, record.version, record.description);
  const instructions = validateRelativeFile(record.instructions, "instructions");
  const resourcesValue = record.resources ?? [];
  if (!Array.isArray(resourcesValue)) {
    throw new SkillValidationError("skill.json resources 必须是 array");
  }
  const resources = resourcesValue.map((entry, index) =>
    validateRelativeFile(entry, `resources[${index}]`),
  );
  if (new Set(resources).size !== resources.length) {
    throw new SkillValidationError("skill.json resources 不能重复");
  }
  if (resources.includes(instructions)) {
    throw new SkillValidationError("instructions 不能同时列入 resources");
  }
  return Object.freeze({
    schemaVersion: 1,
    id: record.id,
    version: record.version,
    description: record.description,
    instructions,
    resources: Object.freeze(resources),
  });
}

export function skillContentDigest(input: {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly instructions: string;
  readonly resources: readonly SkillResource[];
}): string {
  const hash = createHash("sha256");
  hash.update("fast-skill-v1\0");
  for (const value of [input.id, input.version, input.description, input.instructions]) {
    hash.update(value);
    hash.update("\0");
  }
  for (const resource of [...input.resources].sort((left, right) =>
    compareSkillText(left.path, right.path),
  )) {
    hash.update(resource.path);
    hash.update("\0");
    hash.update(resource.content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export const skillSourcePrecedence: Readonly<Record<SkillSourceKind, number>> = {
  built_in: 100,
  extension: 150,
  user: 200,
  project: 300,
};
