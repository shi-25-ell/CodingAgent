import type { AssistantMessage } from "@coding-agent/model";
import { createContextManager } from "./context-manager.js";
import type {
  CompactionStrategy,
  ContextManager,
  TranscriptContextManagerOptions,
} from "./contracts.js";
import { ContextError } from "./errors.js";
import {
  createCurrentTaskContextSource,
  createQueueContextSource,
  createRunBoundaryContextSource,
  createSystemToolContextSource,
  createTranscriptContextSource,
} from "./sources.js";

const noCompaction: CompactionStrategy = {
  version: "disabled",
  async shouldCompact() {
    return false;
  },
  async compact() {
    throw new ContextError("CONTEXT_COMPACTION_UNAVAILABLE", "未配置 CompactionStrategy");
  },
};

/**
 * Minimal adapter retained for embedders and M0-M3 contract scenarios. It uses the same Context pipeline and
 * deterministic budget implementation as production, but deliberately has no summary derivation dependency.
 */
export function createTranscriptContextManager(
  options: TranscriptContextManagerOptions,
): ContextManager {
  return createContextManager({
    sources: [
      createSystemToolContextSource(options.instructions),
      createCurrentTaskContextSource(),
      createQueueContextSource(),
      createTranscriptContextSource(),
      createRunBoundaryContextSource(),
    ],
    compaction: noCompaction,
    modelContextWindow: options.modelContextWindow ?? 32_768,
    requestedOutputReserve: options.maxOutputTokens,
    safetyMargin: 512,
    retainedTailTokens: 4_096,
  });
}

export function responseAsAssistantMessage(
  response: import("@coding-agent/model").ModelResponse,
): AssistantMessage {
  return {
    role: "assistant",
    content: response.content,
    finishReason: response.finishReason,
    ...(response.usage ? { usage: response.usage } : {}),
  };
}
