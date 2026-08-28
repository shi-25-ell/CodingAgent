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
  },
  responseDialect: { terminalUsageRepeatsFinishReason: true },
};
