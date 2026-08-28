import type { ContextSource } from "@coding-agent/agent";

export type SkillSourceKind = "built_in" | "user" | "project";

export interface SkillDiscoveryContext {
  readonly workspaceRoot: string;
  readonly signal?: AbortSignal;
}

export interface SkillProvenance {
  readonly sourceId: string;
  readonly sourceKind: SkillSourceKind;
  /** Stable, source-owned location. It is metadata only and is never executed. */
  readonly location: string;
}

export interface SkillDescriptor {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly digest: string;
  readonly provenance: SkillProvenance;
}

export interface SkillRef {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly sourceId: string;
}

export interface SkillResource {
  readonly path: string;
  readonly content: string;
}

export interface SkillContent {
  readonly instructions: string;
  readonly resources: readonly SkillResource[];
  readonly digest: string;
}

export interface SkillSource {
  readonly id: string;
  readonly kind: SkillSourceKind;
  discover(context: SkillDiscoveryContext): Promise<readonly SkillDescriptor[]>;
  load(ref: SkillRef, options?: { readonly signal?: AbortSignal }): Promise<SkillContent>;
}

export interface SkillQuery {
  readonly sourceKind?: SkillSourceKind;
  readonly text?: string;
}

export interface SkillSelectionInput {
  /** Explicit selections retain this order; duplicate IDs are invalid. */
  readonly ids: readonly string[];
}

export type SkillRegistryDiagnostic = {
  readonly kind: "shadowed";
  readonly skillId: string;
  readonly selected: SkillProvenance;
  readonly shadowed: SkillProvenance;
};

export interface SkillRegistry {
  list(query?: SkillQuery): readonly SkillDescriptor[];
  resolve(id: string): SkillDescriptor;
  select(input: SkillSelectionInput): readonly SkillRef[];
  load(ref: SkillRef, options?: { readonly signal?: AbortSignal }): Promise<SkillContent>;
  diagnostics(): readonly SkillRegistryDiagnostic[];
  contextSource(refs: readonly SkillRef[]): ContextSource;
}

export interface StaticSkillDefinition {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly instructions: string;
  readonly resources?: Readonly<Record<string, string>>;
}

export class SkillValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillValidationError";
  }
}

export class SkillConflictError extends Error {
  readonly skillId: string;
  readonly sourceIds: readonly string[];

  constructor(skillId: string, sourceIds: readonly string[]) {
    super(`Skill ID ${skillId} 在相同 precedence 中冲突: ${sourceIds.join(", ")}`);
    this.name = "SkillConflictError";
    this.skillId = skillId;
    this.sourceIds = Object.freeze([...sourceIds]);
  }
}
