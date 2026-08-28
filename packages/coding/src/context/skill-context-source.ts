import type { ContextContribution, ContextSource, ContextSourceInput } from "@coding-agent/agent";
import type { InstructionPart } from "@coding-agent/model";
import type {
  SkillContent,
  SkillDescriptor,
  SkillRef,
  SkillSourceKind,
} from "../skills/contracts.js";

export interface SelectedSkillLoader {
  descriptor(ref: SkillRef): SkillDescriptor;
  load(ref: SkillRef, options?: { readonly signal?: AbortSignal }): Promise<SkillContent>;
}

function estimate(parts: readonly InstructionPart[]): number {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(parts)).byteLength / 4);
}

function sensitivity(kind: SkillSourceKind): ContextContribution["sensitivity"] {
  if (kind === "built_in") return "public";
  if (kind === "project") return "workspace";
  return "restricted";
}

function render(content: SkillContent): readonly InstructionPart[] {
  const parts: InstructionPart[] = [{ type: "text", text: content.instructions }];
  for (const resource of content.resources) {
    parts.push({
      type: "text",
      text: `Skill resource (${resource.path}):\n${resource.content}`,
    });
  }
  return Object.freeze(parts);
}

export function createSelectedSkillsContextSource(
  refs: readonly SkillRef[],
  loader: SelectedSkillLoader,
): ContextSource {
  const snapshot = Object.freeze(refs.map((ref) => Object.freeze({ ...ref })));
  return Object.freeze({
    id: "selected_skills",
    async collect(input: ContextSourceInput): Promise<readonly ContextContribution[]> {
      const contributions: ContextContribution[] = [];
      for (const [sequence, ref] of snapshot.entries()) {
        if (input.signal.aborted) {
          throw new DOMException("Selected Skill Context 收集已取消", "AbortError");
        }
        const descriptor = loader.descriptor(ref);
        const content = await loader.load(ref, { signal: input.signal });
        const parts = render(content);
        contributions.push(
          Object.freeze({
            id: `skill:${descriptor.id}:${descriptor.digest}`,
            sourceId: "selected_skills",
            priority: 850,
            required: true,
            orderingGroup: "skills",
            sequence,
            estimatedTokens: estimate(parts),
            provenance: Object.freeze({
              kind: "skill",
              id: descriptor.id,
              digest: descriptor.digest,
              attributes: Object.freeze({
                version: descriptor.version,
                sourceId: descriptor.provenance.sourceId,
                sourceKind: descriptor.provenance.sourceKind,
                location: descriptor.provenance.location,
              }),
            }),
            sensitivity: sensitivity(descriptor.provenance.sourceKind),
            content: Object.freeze({ kind: "instructions", parts }),
          }),
        );
      }
      return Object.freeze(contributions);
    },
  });
}
