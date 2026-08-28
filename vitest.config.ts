import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@coding-agent/model/testing",
        replacement: `${root}packages/model/src/testing/index.ts`,
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
