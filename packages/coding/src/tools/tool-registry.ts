import type { ToolDefinition } from "@coding-agent/agent";
import type { JsonObject } from "@coding-agent/model";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

export interface ToolValidationSuccess {
  readonly valid: true;
  readonly value: JsonObject;
}

export interface ToolValidationFailure {
  readonly valid: false;
  readonly errors: readonly ErrorObject[];
}

export type ToolValidation = ToolValidationSuccess | ToolValidationFailure;

export interface ToolRegistration {
  readonly definition: ToolDefinition;
}

export interface RegisteredTool extends ToolRegistration {
  validate(value: unknown): ToolValidation;
}

export interface ToolRegistrySnapshot {
  definitions(): readonly ToolDefinition[];
  lookup(name: string): RegisteredTool | undefined;
}

function cloneAndFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object" || Object.isFrozen(candidate)) return;
    for (const child of Object.values(candidate)) visit(child);
    Object.freeze(candidate);
  };
  visit(cloned);
  return cloned;
}

export class ToolRegistry {
  readonly #ajv = new Ajv({
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    strict: true,
    useDefaults: false,
  });
  readonly #registrations = new Map<string, RegisteredTool>();
  #snapshot: ToolRegistrySnapshot | undefined;

  register(registration: ToolRegistration): void {
    if (this.#snapshot) throw new Error("ToolRegistry 已冻结");
    const { definition } = registration;
    if (this.#registrations.has(definition.name)) {
      throw new Error(`重复 tool name: ${definition.name}`);
    }
    if (
      definition.inputSchema.type !== "object" ||
      definition.inputSchema.additionalProperties !== false
    ) {
      throw new Error(`tool ${definition.name} schema 必须声明 additionalProperties:false`);
    }
    const frozenDefinition = cloneAndFreeze(definition);
    const validate: ValidateFunction = this.#ajv.compile(frozenDefinition.inputSchema);
    const tool: RegisteredTool = Object.freeze({
      definition: frozenDefinition,
      validate(value: unknown): ToolValidation {
        if (validate(value)) {
          return { valid: true, value: cloneAndFreeze(value as JsonObject) };
        }
        return {
          valid: false,
          errors: cloneAndFreeze(validate.errors ?? []),
        };
      },
    });
    this.#registrations.set(definition.name, tool);
  }

  snapshot(): ToolRegistrySnapshot {
    if (this.#snapshot) return this.#snapshot;
    const tools = new Map(this.#registrations);
    const definitions = Object.freeze([...tools.values()].map((tool) => tool.definition));
    this.#snapshot = Object.freeze({
      definitions: () => definitions,
      lookup: (name: string) => tools.get(name),
    });
    return this.#snapshot;
  }
}
