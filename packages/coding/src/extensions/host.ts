import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv } from "ajv";
import {
  type ExtensionApi,
  type ExtensionCapability,
  type ExtensionDiagnostic,
  type ExtensionHost,
  type ExtensionInitializer,
  type ExtensionManifest,
  type ExtensionRegistration,
  type ExtensionSnapshot,
  type ExtensionSource,
  extensionApiVersion,
  extensionManifestFile,
  type LoadedExtension,
} from "./contracts.js";

const sourceOrder = Object.freeze({ built_in: 0, user: 1, project: 2, explicit: 3 });
const idPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const capabilities: readonly ExtensionCapability[] = [
  "tool",
  "command",
  "mode",
  "skill_source",
  "context_source",
  "model_provider",
  "credential_source",
  "observation_hook",
];

const manifestSchema = {
  type: "object",
  properties: {
    schemaVersion: { const: 1 },
    namespace: { const: "coding-agent" },
    id: { type: "string", pattern: idPattern.source },
    version: { type: "string", pattern: semverPattern.source },
    apiVersion: { type: "string", pattern: semverPattern.source },
    entry: { type: "string", minLength: 1 },
    displayName: { type: "string", minLength: 1, maxLength: 200 },
    capabilities: { type: "array", uniqueItems: true, items: { enum: capabilities } },
  },
  required: ["schemaVersion", "namespace", "id", "version", "apiVersion", "entry", "capabilities"],
  additionalProperties: false,
} as const;

interface MutableContributions {
  tools: ExtensionSnapshot["tools"][number][];
  commands: ExtensionSnapshot["commands"][number][];
  modes: ExtensionSnapshot["modes"][number][];
  skillSources: ExtensionSnapshot["skillSources"][number][];
  contextSources: ExtensionSnapshot["contextSources"][number][];
  modelProviders: ExtensionSnapshot["modelProviders"][number][];
  credentialSources: ExtensionSnapshot["credentialSources"][number][];
  hooks: ExtensionSnapshot["hooks"][number][];
}

interface LoadedMutable extends LoadedExtension {
  readonly registrations: ExtensionRegistration[];
}

class RegistrationError extends Error {
  readonly code: "EXTENSION_CAPABILITY_MISMATCH" | "EXTENSION_REGISTRATION_CONFLICT";

  constructor(code: RegistrationError["code"], message: string) {
    super(message);
    this.name = "RegistrationError";
    this.code = code;
  }
}

export interface CreateExtensionHostOptions {
  readonly sources: readonly ExtensionSource[];
  readonly enabled: readonly string[];
  readonly redact?: (value: string) => string;
  readonly reservedRegistrations?: readonly string[];
}

function major(version: string): number {
  return Number(version.split(".")[0]);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function manifestPaths(source: ExtensionSource): Promise<readonly string[]> {
  const absolute = path.resolve(source.path);
  if (path.basename(absolute) === extensionManifestFile) return [absolute];
  try {
    const direct = path.join(absolute, extensionManifestFile);
    await readFile(direct, "utf8");
    return [direct];
  } catch {}
  try {
    const entries = await readdir(absolute, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(absolute, entry.name, extensionManifestFile))
      .sort();
    const existing: string[] = [];
    for (const candidate of candidates) {
      try {
        await readFile(candidate, "utf8");
        existing.push(candidate);
      } catch {}
    }
    return existing;
  } catch {
    return [];
  }
}

function freezeSnapshot(
  loaded: readonly LoadedMutable[],
  values: MutableContributions,
): ExtensionSnapshot {
  return Object.freeze({
    extensions: Object.freeze(
      loaded.map(({ registrations: _registrations, ...item }) => Object.freeze(item)),
    ),
    tools: Object.freeze([...values.tools]),
    commands: Object.freeze([...values.commands]),
    modes: Object.freeze([...values.modes]),
    skillSources: Object.freeze([...values.skillSources]),
    contextSources: Object.freeze([...values.contextSources]),
    modelProviders: Object.freeze([...values.modelProviders]),
    credentialSources: Object.freeze([...values.credentialSources]),
    hooks: Object.freeze([...values.hooks]),
  });
}

export async function createExtensionHost(
  options: CreateExtensionHostOptions,
): Promise<ExtensionHost> {
  if (new Set(options.enabled).size !== options.enabled.length)
    throw new TypeError("enabled extension 不能重复");
  const redact = options.redact ?? ((value: string) => value);
  const enabledPaths = new Set(options.enabled.map((value) => path.resolve(value)));
  const diagnostics: ExtensionDiagnostic[] = [];
  const values: MutableContributions = {
    tools: [],
    commands: [],
    modes: [],
    skillSources: [],
    contextSources: [],
    modelProviders: [],
    credentialSources: [],
    hooks: [],
  };
  const loaded: LoadedMutable[] = [];
  const discovered: {
    source: ExtensionSource;
    manifestPath: string;
    manifest: ExtensionManifest;
  }[] = [];
  const discoveredManifestPaths = new Set<string>();
  const validate = new Ajv({ allErrors: true, strict: true }).compile(manifestSchema);
  const orderedSources = [...options.sources].sort(
    (left, right) =>
      sourceOrder[left.kind] - sourceOrder[right.kind] || left.path.localeCompare(right.path),
  );
  for (const source of orderedSources) {
    for (const manifestPath of await manifestPaths(source)) {
      try {
        const canonicalManifestPath = await realpath(manifestPath);
        if (discoveredManifestPaths.has(canonicalManifestPath)) continue;
        const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
        if (!validate(value)) throw new Error("manifest schema validation failed");
        const manifest = value as ExtensionManifest;
        const root = await realpath(path.dirname(manifestPath));
        const entry = path.resolve(root, manifest.entry);
        if (!inside(root, entry)) throw new Error("entry 必须位于 extension bundle 内");
        discoveredManifestPaths.add(canonicalManifestPath);
        discovered.push({
          source: Object.freeze({ ...source }),
          manifestPath: canonicalManifestPath,
          manifest: Object.freeze({
            ...manifest,
            capabilities: Object.freeze([...manifest.capabilities]),
          }),
        });
      } catch (error) {
        diagnostics.push({
          code: "EXTENSION_MANIFEST_INVALID",
          severity: "error",
          source,
          message: redact(error instanceof Error ? error.message : String(error)),
        });
      }
    }
  }
  const byId = new Map<string, typeof discovered>();
  for (const item of discovered)
    byId.set(item.manifest.id, [...(byId.get(item.manifest.id) ?? []), item]);
  const registrationIds = new Map<string, string>();
  for (const identity of options.reservedRegistrations ?? []) {
    if (registrationIds.has(identity))
      throw new TypeError(`reserved registration 重复: ${identity}`);
    registrationIds.set(identity, "core");
  }
  for (const [id, candidates] of [...byId].sort(([left], [right]) => left.localeCompare(right))) {
    if (candidates.length !== 1) {
      for (const candidate of candidates)
        diagnostics.push({
          code: "EXTENSION_DUPLICATE_ID",
          severity: "error",
          extensionId: id,
          source: candidate.source,
          message: `duplicate extension ID: ${id}`,
        });
      continue;
    }
    const item = candidates[0];
    if (!item) continue;
    if (
      !options.enabled.includes(id) &&
      !enabledPaths.has(path.resolve(path.dirname(item.manifestPath)))
    ) {
      diagnostics.push({
        code: "EXTENSION_NOT_ENABLED",
        severity: "info",
        extensionId: id,
        source: item.source,
        message: `extension ${id} 未显式启用`,
      });
      continue;
    }
    if (major(item.manifest.apiVersion) !== major(extensionApiVersion)) {
      diagnostics.push({
        code: "EXTENSION_INCOMPATIBLE",
        severity: "error",
        extensionId: id,
        source: item.source,
        message: `extension API ${item.manifest.apiVersion} 与 host ${extensionApiVersion} 不兼容`,
      });
      continue;
    }
    const registrations: ExtensionRegistration[] = [];
    const startLengths = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, value.length]),
    );
    const register = <T>(
      capability: ExtensionCapability,
      group: keyof MutableContributions,
      identity: string,
      value: T,
    ): ExtensionRegistration => {
      if (!item.manifest.capabilities.includes(capability)) {
        throw new RegistrationError(
          "EXTENSION_CAPABILITY_MISMATCH",
          `capability mismatch: ${capability}`,
        );
      }
      const conflict = registrationIds.get(identity);
      if (conflict) {
        throw new RegistrationError(
          "EXTENSION_REGISTRATION_CONFLICT",
          `registration conflict ${identity} (${conflict}, ${id})`,
        );
      }
      registrationIds.set(identity, id);
      (values[group] as T[]).push(value);
      let active = true;
      const registration = {
        dispose() {
          if (!active) return;
          active = false;
          const list = values[group] as T[];
          const index = list.indexOf(value);
          if (index >= 0) list.splice(index, 1);
          if (registrationIds.get(identity) === id) registrationIds.delete(identity);
        },
      };
      registrations.push(registration);
      return registration;
    };
    const apiDefinition: ExtensionApi = {
      registerTool: (value) => register("tool", "tools", `tool:${value.definition.name}`, value),
      registerCommand: (value) => {
        const bindingKeys = (value.bindings ?? []).map((binding) => `binding:${binding}`);
        for (const key of bindingKeys) {
          const conflict = registrationIds.get(key);
          if (conflict) {
            throw new RegistrationError(
              "EXTENSION_REGISTRATION_CONFLICT",
              `key conflict ${key.slice("binding:".length)} (${conflict}, ${id})`,
            );
          }
        }
        const primary = register("command", "commands", `command:${value.kind}:${value.id}`, value);
        for (const key of bindingKeys) registrationIds.set(key, id);
        const wrapped = {
          dispose() {
            primary.dispose();
            for (const key of bindingKeys) {
              if (registrationIds.get(key) === id) registrationIds.delete(key);
            }
          },
        };
        registrations.pop();
        registrations.push(wrapped);
        return wrapped;
      },
      registerMode: (value) => register("mode", "modes", `mode:${value.descriptor.id}`, value),
      registerSkillSource: (value) =>
        register("skill_source", "skillSources", `skill-source:${value.id}`, value),
      registerContextSource: (value) =>
        register("context_source", "contextSources", `context-source:${value.id}`, value),
      registerModelProvider: (value) =>
        register("model_provider", "modelProviders", `model-provider:${value.id}`, value),
      registerCredentialSource: (value) =>
        register("credential_source", "credentialSources", `credential-source:${value.id}`, value),
      observe: (value) => register("observation_hook", "hooks", `hook:${value.id}`, value),
    };
    const api = Object.freeze(apiDefinition);
    try {
      const entry = path.resolve(path.dirname(item.manifestPath), item.manifest.entry);
      const module = (await import(pathToFileURL(entry).href)) as {
        default?: ExtensionInitializer;
        activate?: ExtensionInitializer;
      };
      const initialize = module.default ?? module.activate;
      if (typeof initialize !== "function")
        throw new Error("extension entry 必须 export default 或 activate initializer");
      await initialize(api);
      loaded.push({
        manifest: item.manifest,
        source: item.source,
        acceptedCapabilities: item.manifest.capabilities,
        registrations,
      });
    } catch (error) {
      [...registrations].reverse().forEach((registration) => {
        registration.dispose();
      });
      for (const [key, length] of Object.entries(startLengths))
        (values[key as keyof MutableContributions] as unknown[]).splice(length as number);
      diagnostics.push({
        code: error instanceof RegistrationError ? error.code : "EXTENSION_LOAD_FAILED",
        severity: "error",
        extensionId: id,
        source: item.source,
        message: redact(error instanceof Error ? error.message : String(error)),
      });
      diagnostics.push({
        code: "EXTENSION_REGISTRATION_ROLLED_BACK",
        severity: "warning",
        extensionId: id,
        source: item.source,
        message: `extension ${id} registrations 已回滚`,
      });
    }
  }
  let snapshot = freezeSnapshot(loaded, values);
  return {
    snapshot: () => snapshot,
    diagnostics: () => Object.freeze([...diagnostics]),
    async observe(event) {
      await Promise.all(
        snapshot.hooks.map(async (hook) => {
          const timeoutMs = hook.timeoutMs ?? 1_000;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.resolve(hook.onEvent(event)),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("hook timeout")), timeoutMs);
              }),
            ]);
          } catch (error) {
            const ownerId = registrationIds.get(`hook:${hook.id}`);
            const owner = loaded.find((extension) => extension.manifest.id === ownerId);
            diagnostics.push({
              code:
                error instanceof Error && error.message === "hook timeout"
                  ? "EXTENSION_HOOK_TIMEOUT"
                  : "EXTENSION_HOOK_FAILED",
              severity: "warning",
              ...(owner
                ? { extensionId: owner.manifest.id, source: owner.source }
                : { source: { kind: "built_in", path: "host" } }),
              message: redact(error instanceof Error ? error.message : String(error)),
            });
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      );
    },
    async disable(id) {
      const index = loaded.findIndex((item) => item.manifest.id === id);
      const extension = loaded[index];
      if (!extension) return false;
      [...extension.registrations].reverse().forEach((registration) => {
        registration.dispose();
      });
      loaded.splice(index, 1);
      snapshot = freezeSnapshot(loaded, values);
      return true;
    },
    async [Symbol.asyncDispose]() {
      for (const extension of [...loaded].reverse())
        [...extension.registrations].reverse().forEach((registration) => {
          registration.dispose();
        });
      loaded.splice(0);
      snapshot = freezeSnapshot(loaded, values);
    },
  };
}
