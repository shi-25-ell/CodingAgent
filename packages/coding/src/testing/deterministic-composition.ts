import {
  createAgent,
  createAgentHarness,
  createDisabledToolExecutor,
  createFixedRunPolicies,
  createTranscriptContextManager,
  type FixedRunPolicyOptions,
} from "@coding-agent/agent";
import {
  InMemorySessionRepository,
  ManualClock,
  SequentialIdFactory,
} from "@coding-agent/agent/testing";
import type { InstructionPart, Model } from "@coding-agent/model";
import { type CodingAgent, createCodingAgent } from "../app/coding-agent.js";

export interface DeterministicCodingAgentOptions {
  readonly model: Model;
  readonly instructions?: readonly InstructionPart[];
  readonly policies?: FixedRunPolicyOptions;
}

export interface DeterministicCodingAgent {
  readonly agent: CodingAgent;
  dispose(): Promise<void>;
}

export function createDeterministicCodingAgent(
  options: DeterministicCodingAgentOptions,
): DeterministicCodingAgent {
  const clock = new ManualClock(0);
  const ids = new SequentialIdFactory();
  const sessions = new InMemorySessionRepository({ clock, ids });
  const agent = createCodingAgent({
    sessions,
    harness: createAgentHarness({ agent: createAgent() }),
    model: options.model,
    tools: createDisabledToolExecutor(),
    context: createTranscriptContextManager({
      instructions: options.instructions ?? [],
      maxOutputTokens: 1_024,
    }),
    policies: createFixedRunPolicies(
      options.policies ?? { maxModelTurns: 1, maxModelAttempts: 1, maxRetries: 0 },
    ),
    configurationRevision: "deterministic-1",
    workspace: {
      async inspect(root) {
        return {
          binding: { root, fingerprint: "head:abc" },
          head: "abc",
          branch: "main",
          clean: true,
          changedPaths: [],
        };
      },
      async readDiff(input) {
        return { version: 1, revision: "deterministic-empty", source: input.source, files: [] };
      },
    },
  });
  return {
    agent,
    async dispose() {
      await sessions[Symbol.asyncDispose]();
    },
  };
}
