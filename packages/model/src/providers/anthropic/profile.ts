import { providerId } from "../../api/contracts.js";
import { credentialRef } from "../../auth/contracts.js";
import type { AnthropicProfile } from "./contracts.js";

export const anthropicProfile: AnthropicProfile = {
  id: providerId("anthropic"),
  displayName: "Anthropic",
  baseUrl: new URL("https://api.anthropic.com/"),
  auth: { ref: credentialRef("anthropic.default"), kind: "api_key" },
  version: "2023-06-01",
};
