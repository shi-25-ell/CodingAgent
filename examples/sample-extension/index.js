import { createHash } from "node:crypto";

const instructions =
  "使用 sample_echo tool 回显用户明确要求核对的短文本，并在结果中说明该能力来自 extension。";
const digest = `sha256:${createHash("sha256").update(instructions).digest("hex")}`;

export default function activate(api) {
  api.registerTool({
    definition: {
      name: "sample_echo",
      description: "由 sample extension 提供的有界文本回显工具",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", minLength: 1, maxLength: 500 } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    plan() {
      return { resources: [], effects: [], risks: [] };
    },
    async execute({ arguments: arguments_ }) {
      return { modelContent: JSON.stringify({ echo: arguments_.text, source: "extension" }) };
    },
  });
  api.registerSkillSource({
    id: "dex-sample-skills",
    kind: "extension",
    async discover() {
      return [
        {
          id: "sample.echo",
          version: "1.0.0",
          description: "指导 Agent 使用 sample extension 的 echo tool",
          digest,
          provenance: {
            sourceId: "dex-sample-skills",
            sourceKind: "extension",
            location: "extension:dex.sample/sample.echo",
          },
        },
      ];
    },
    async load(ref) {
      if (ref.id !== "sample.echo" || ref.digest !== digest)
        throw new Error("unknown sample skill ref");
      return { instructions, resources: [], digest };
    },
  });
}
