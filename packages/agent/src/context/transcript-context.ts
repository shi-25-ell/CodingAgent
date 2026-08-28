import type { AssistantMessage, ModelMessage } from "@coding-agent/model";
import type {
  ContextManager,
  ContextPrepareInput,
  PreparedContext,
  TranscriptContextManagerOptions,
} from "./contracts.js";

function projectMessages(input: ContextPrepareInput): readonly ModelMessage[] {
  return input.branch.records.flatMap((record): readonly ModelMessage[] => {
    if (record.kind === "user_message") {
      return [{ role: "user", content: [{ type: "text", text: record.text }] }];
    }
    if (record.kind === "assistant_message") return [record.message];
    if (record.kind === "tool_outcome") {
      return [
        {
          role: "tool",
          callId: record.outcome.callId,
          content: record.outcome.modelContent,
          isError: record.outcome.isError,
        },
      ];
    }
    return [];
  });
}

function estimateTokens(messages: readonly ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function createTranscriptContextManager(
  options: TranscriptContextManagerOptions,
): ContextManager {
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0) {
    throw new TypeError("maxOutputTokens 必须是正整数");
  }
  return {
    async prepare(input): Promise<PreparedContext> {
      const messages = projectMessages(input);
      return {
        request: {
          version: 1,
          instructions: options.instructions,
          messages,
          tools: input.tools,
          output: { maxTokens: options.maxOutputTokens },
        },
        manifest: {
          version: 1,
          id: `${input.runId}:attempt-${input.modelAttemptCount}`,
          runId: input.runId,
          modelAttemptCount: input.modelAttemptCount,
          selectedRecordIds: input.branch.records
            .filter(
              (record) =>
                record.kind === "user_message" ||
                record.kind === "assistant_message" ||
                record.kind === "tool_outcome",
            )
            .map((record) => record.recordId),
          omitted: [],
        },
        measurement: {
          method: "estimated_chars",
          inputTokens: estimateTokens(messages),
          outputReserve: options.maxOutputTokens,
        },
      };
    },
  };
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
