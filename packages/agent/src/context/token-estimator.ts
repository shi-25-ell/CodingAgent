import type {
  InstructionPart,
  ModelMessage,
  ModelRequest,
  ModelToolDefinition,
} from "@coding-agent/model";

export function estimateTextTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).byteLength / 4);
}

export function estimateInstructions(parts: readonly InstructionPart[]): number {
  return estimateTextTokens(JSON.stringify(parts));
}

export function estimateMessages(messages: readonly ModelMessage[]): number {
  return estimateTextTokens(JSON.stringify(messages));
}

export function estimateTools(tools: readonly ModelToolDefinition[]): number {
  return estimateTextTokens(JSON.stringify(tools));
}

export function estimateRequestInput(request: ModelRequest): number {
  return estimateInstructions(request.instructions) + estimateMessages(request.messages);
}
