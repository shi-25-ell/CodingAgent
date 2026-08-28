import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: [
        "packages/model/src/auth/{contracts,credential-resolver,environment-credential-source,local-config-credential-source}.ts",
        "packages/model/src/catalog/model-registry.ts",
        "packages/model/src/providers/openai-compatible/{fetch-transport,profile,provider}.ts",
        "packages/agent/src/agent/agent.ts",
        "packages/agent/src/agent/run-state-machine.ts",
        "packages/agent/src/context/transcript-context.ts",
        "packages/agent/src/harness/agent-harness.ts",
        "packages/agent/src/policies/fixed-policies.ts",
        "packages/agent/src/runtime/contracts.ts",
        "packages/agent/src/session/contracts.ts",
        "packages/agent/src/session/errors.ts",
        "packages/agent/src/session/in-memory-session-repository.ts",
        "packages/agent/src/tools/contracts.ts",
        "packages/coding/src/app/coding-agent.ts",
        "packages/coding/src/adapters/node-local-execution-adapters.ts",
        "packages/coding/src/composition/openai-composition.ts",
        "packages/coding/src/composition/local-tool-composition.ts",
        "packages/coding/src/index.ts",
        "packages/coding/src/modes/print/print-entry.ts",
        "packages/coding/src/permissions/approval-bridge.ts",
        "packages/coding/src/tools/coding-tool-host.ts",
        "packages/coding/src/tools/ephemeral-artifact-store.ts",
        "packages/coding/src/tools/local-execution-ports.ts",
        "packages/coding/src/tools/tool-registry.ts",
        "packages/sqlite/src/**/*.ts",
      ],
      thresholds: { lines: 85, branches: 75 },
    },
  },
  resolve: {
    alias: [
      {
        find: "@coding-agent/model/testing",
        replacement: `${root}packages/model/src/testing/index.ts`,
      },
      {
        find: "@coding-agent/model/providers/openai-compatible",
        replacement: `${root}packages/model/src/providers/openai-compatible/index.ts`,
      },
      {
        find: "@coding-agent/model/auth",
        replacement: `${root}packages/model/src/auth/index.ts`,
      },
      { find: "@coding-agent/model", replacement: `${root}packages/model/src/index.ts` },
      {
        find: "@coding-agent/agent/session",
        replacement: `${root}packages/agent/src/session/index.ts`,
      },
      {
        find: "@coding-agent/agent/context",
        replacement: `${root}packages/agent/src/context/index.ts`,
      },
      {
        find: "@coding-agent/agent/testing",
        replacement: `${root}packages/agent/src/testing/index.ts`,
      },
      { find: "@coding-agent/agent", replacement: `${root}packages/agent/src/index.ts` },
      { find: "@coding-agent/sqlite", replacement: `${root}packages/sqlite/src/index.ts` },
      {
        find: "@coding-agent/coding/print",
        replacement: `${root}packages/coding/src/modes/print/index.ts`,
      },
      {
        find: "@coding-agent/coding/testing",
        replacement: `${root}packages/coding/src/testing/index.ts`,
      },
      { find: "@coding-agent/coding", replacement: `${root}packages/coding/src/index.ts` },
    ],
  },
});
