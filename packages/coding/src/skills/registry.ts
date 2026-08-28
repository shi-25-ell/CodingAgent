import { createSelectedSkillsContextSource } from "../context/skill-context-source.js";
import {
  compareSkillText,
  skillSourcePrecedence,
  validateSkillIdentity,
  validateSourceId,
} from "./content.js";
import type {
  SkillDescriptor,
  SkillDiscoveryContext,
  SkillQuery,
  SkillRef,
  SkillRegistry,
  SkillRegistryDiagnostic,
  SkillSelectionInput,
  SkillSource,
} from "./contracts.js";
import { SkillConflictError, SkillValidationError } from "./contracts.js";

const digestPattern = /^sha256:[0-9a-f]{64}$/;

function validateDescriptor(descriptor: SkillDescriptor, source: SkillSource): void {
  validateSkillIdentity(descriptor.id, descriptor.version, descriptor.description);
  if (
    descriptor.provenance.sourceId !== source.id ||
    descriptor.provenance.sourceKind !== source.kind
  ) {
    throw new SkillValidationError(`Skill source ${source.id} 返回了错误 provenance`);
  }
  if (!digestPattern.test(descriptor.digest)) {
    throw new SkillValidationError(`Skill ${descriptor.id} digest 无效`);
  }
  if (descriptor.provenance.location.trim().length === 0) {
    throw new SkillValidationError(`Skill ${descriptor.id} provenance location 不能为空`);
  }
}

function matches(descriptor: SkillDescriptor, query?: SkillQuery): boolean {
  if (query?.sourceKind && descriptor.provenance.sourceKind !== query.sourceKind) return false;
  if (query?.text) {
    const needle = query.text.toLocaleLowerCase("en-US");
    return `${descriptor.id}\n${descriptor.description}`
      .toLocaleLowerCase("en-US")
      .includes(needle);
  }
  return true;
}

export async function createSkillRegistry(
  sources: readonly SkillSource[],
  context: SkillDiscoveryContext,
): Promise<SkillRegistry> {
  const sourceById = new Map<string, SkillSource>();
  for (const source of sources) {
    validateSourceId(source.id);
    if (sourceById.has(source.id)) {
      throw new SkillConflictError(`source:${source.id}`, [source.id, source.id]);
    }
    sourceById.set(source.id, source);
  }

  const discovered: SkillDescriptor[] = [];
  for (const source of sources) {
    if (context.signal?.aborted) throw new DOMException("Skill discovery 已取消", "AbortError");
    for (const descriptor of await source.discover(context)) {
      validateDescriptor(descriptor, source);
      discovered.push(
        Object.freeze({
          id: descriptor.id,
          version: descriptor.version,
          description: descriptor.description,
          digest: descriptor.digest,
          provenance: Object.freeze({ ...descriptor.provenance }),
        }),
      );
    }
  }

  const selected = new Map<string, SkillDescriptor>();
  const diagnostics: SkillRegistryDiagnostic[] = [];
  const byId = new Map<string, SkillDescriptor[]>();
  for (const descriptor of discovered) {
    const peers = byId.get(descriptor.id) ?? [];
    peers.push(descriptor);
    byId.set(descriptor.id, peers);
  }
  for (const [id, descriptors] of byId) {
    const byPrecedence = new Map<number, SkillDescriptor[]>();
    for (const descriptor of descriptors) {
      const precedence = skillSourcePrecedence[descriptor.provenance.sourceKind];
      const peers = byPrecedence.get(precedence) ?? [];
      peers.push(descriptor);
      byPrecedence.set(precedence, peers);
    }
    for (const peers of byPrecedence.values()) {
      if (peers.length > 1) {
        throw new SkillConflictError(
          id,
          peers.map((descriptor) => descriptor.provenance.sourceId).sort(compareSkillText),
        );
      }
    }
    const ordered = [...descriptors].sort(
      (left, right) =>
        skillSourcePrecedence[right.provenance.sourceKind] -
          skillSourcePrecedence[left.provenance.sourceKind] ||
        compareSkillText(left.provenance.sourceId, right.provenance.sourceId),
    );
    const winner = ordered[0];
    if (!winner) continue;
    selected.set(id, winner);
    for (const shadowed of ordered.slice(1)) {
      diagnostics.push(
        Object.freeze({
          kind: "shadowed",
          skillId: id,
          selected: winner.provenance,
          shadowed: shadowed.provenance,
        }),
      );
    }
  }

  const catalog = Object.freeze(
    [...selected.values()].sort((left, right) => compareSkillText(left.id, right.id)),
  );
  const diagnosticSnapshot = Object.freeze(
    diagnostics.sort(
      (left, right) =>
        compareSkillText(left.skillId, right.skillId) ||
        compareSkillText(left.shadowed.sourceId, right.shadowed.sourceId),
    ),
  );

  const descriptorForRef = (ref: SkillRef): SkillDescriptor => {
    const descriptor = selected.get(ref.id);
    if (
      !descriptor ||
      descriptor.version !== ref.version ||
      descriptor.digest !== ref.digest ||
      descriptor.provenance.sourceId !== ref.sourceId
    ) {
      throw new SkillValidationError(`Skill ref 不属于当前 registry snapshot: ${ref.id}`);
    }
    return descriptor;
  };

  const registry: SkillRegistry = Object.freeze({
    list(query?: SkillQuery): readonly SkillDescriptor[] {
      return Object.freeze(catalog.filter((descriptor) => matches(descriptor, query)));
    },
    resolve(id: string): SkillDescriptor {
      const descriptor = selected.get(id);
      if (!descriptor) throw new SkillValidationError(`未知 Skill ID: ${id}`);
      return descriptor;
    },
    select(input: SkillSelectionInput): readonly SkillRef[] {
      if (new Set(input.ids).size !== input.ids.length) {
        throw new SkillValidationError("Skill selection 不能包含重复 ID");
      }
      return Object.freeze(
        input.ids.map((id) => {
          const descriptor = registry.resolve(id);
          return Object.freeze({
            id: descriptor.id,
            version: descriptor.version,
            digest: descriptor.digest,
            sourceId: descriptor.provenance.sourceId,
          });
        }),
      );
    },
    async load(ref: SkillRef, options?: { readonly signal?: AbortSignal }) {
      const descriptor = descriptorForRef(ref);
      const source = sourceById.get(descriptor.provenance.sourceId);
      if (!source) throw new SkillValidationError(`Skill source snapshot 丢失: ${ref.sourceId}`);
      const content = await source.load(ref, options);
      if (content.digest !== ref.digest) {
        throw new SkillValidationError(`Skill ${ref.id} load digest 与 discovery snapshot 不一致`);
      }
      return content;
    },
    diagnostics(): readonly SkillRegistryDiagnostic[] {
      return diagnosticSnapshot;
    },
    contextSource(refs: readonly SkillRef[]) {
      if (new Set(refs.map((ref) => ref.id)).size !== refs.length) {
        throw new SkillValidationError("Selected Skill Context 不能包含重复 ID");
      }
      for (const ref of refs) descriptorForRef(ref);
      return createSelectedSkillsContextSource(refs, {
        descriptor: descriptorForRef,
        load: (ref, options) => registry.load(ref, options),
      });
    },
  });
  return registry;
}
