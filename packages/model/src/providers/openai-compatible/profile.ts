import { providerId } from "../../api/contracts.js";
import { credentialRef } from "../../auth/contracts.js";
import type { OpenAiCompatibleProfile } from "./contracts.js";

export const openAiProfile: OpenAiCompatibleProfile = {
  id: providerId("openai"),
  baseUrl: new URL("https://api.openai.com/v1/"),
  auth: { ref: credentialRef("openai.default"), kind: "bearer" },
  requestDialect: {
    instructionsRole: "developer",
    maxTokensField: "max_completion_tokens",
  },
  responseDialect: {},
};
