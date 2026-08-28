import { providerId } from "../../api/contracts.js";
import { credentialRef } from "../../auth/contracts.js";
import type { OpenAiCompatibleProfile } from "./contracts.js";

export const openAiProfile: OpenAiCompatibleProfile = {
  id: providerId("openai"),
  displayName: "OpenAI",
  baseUrl: new URL("https://api.openai.com/v1/"),
  auth: { ref: credentialRef("openai.default"), kind: "bearer" },
  requestDialect: {
    instructionsRole: "developer",
    maxTokensField: "max_completion_tokens",
    includeUsageStreamOption: true,
    strictToolSchema: true,
    parallelToolCallsField: true,
  },
  responseDialect: {},
};

export const openRouterProfile: OpenAiCompatibleProfile = {
  id: providerId("openrouter"),
  displayName: "OpenRouter",
  baseUrl: new URL("https://openrouter.ai/api/v1/"),
  auth: { ref: credentialRef("openrouter.default"), kind: "bearer" },
  requestDialect: {
    instructionsRole: "system",
    maxTokensField: "max_completion_tokens",
    includeUsageStreamOption: true,
    strictToolSchema: true,
    parallelToolCallsField: true,
  },
  responseDialect: { terminalUsageRepeatsFinishReason: true },
};

export const deepSeekProfile: OpenAiCompatibleProfile = {
  id: providerId("deepseek"),
  displayName: "DeepSeek",
  baseUrl: new URL("https://api.deepseek.com/"),
  auth: { ref: credentialRef("deepseek.default"), kind: "bearer" },
  requestDialect: {
    instructionsRole: "system",
    maxTokensField: "max_tokens",
    reasoningReplayField: "reasoning_content",
    includeUsageStreamOption: true,
    strictToolSchema: false,
    parallelToolCallsField: false,
    additionalBody: { thinking: { type: "enabled" } },
  },
  responseDialect: { reasoningDeltaField: "reasoning_content" },
};

export const glmProfile: OpenAiCompatibleProfile = {
  id: providerId("glm"),
  displayName: "GLM",
  baseUrl: new URL("https://open.bigmodel.cn/api/paas/v4/"),
  auth: { ref: credentialRef("glm.default"), kind: "bearer" },
  requestDialect: {
    instructionsRole: "system",
    maxTokensField: "max_tokens",
    reasoningReplayField: "reasoning_content",
    includeUsageStreamOption: false,
    strictToolSchema: false,
    parallelToolCallsField: false,
    additionalBody: { thinking: { type: "enabled" } },
    toolBody: { tool_stream: true },
  },
  responseDialect: { reasoningDeltaField: "reasoning_content" },
};
