import type { RunReport, WorkspaceBinding } from "@coding-agent/agent";
import type { CodingAgent } from "../../app/coding-agent.js";
import { productIdentity } from "../../product/index.js";
import { reduceProjection } from "../../projection/projection.js";
import type { InteractionMode } from "../registry.js";

export interface PrintIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface PrintEntryDependencies {
  readonly agent: CodingAgent;
  readonly workspace: WorkspaceBinding;
  readonly io: PrintIo;
}

export type PrintEntryResult =
  | { readonly exitCode: 2; readonly status: "usage_error" }
  | {
      readonly exitCode: 0 | 1 | 130;
      readonly status: RunReport["status"];
      readonly report: RunReport;
    }
  | { readonly exitCode: 1; readonly status: "start_error" };

function usageError(message: string, io: PrintIo): PrintEntryResult {
  io.stderr(`${message}\n用法: ${productIdentity.executable} --print "Coding Task"\n`);
  return { exitCode: 2, status: "usage_error" };
}

function parseTask(argv: readonly string[], io: PrintIo): string | PrintEntryResult {
  if (argv.length === 0) return usageError("缺少 --print 参数。", io);
  if (argv[0] !== "--print") return usageError(`未知参数: ${argv[0]}`, io);
  if (argv.length !== 2 || !argv[1] || argv[1].trim().length === 0) {
    return usageError("--print 需要且只接受一个非空 Coding Task。", io);
  }
  return argv[1];
}

export async function runPrintEntry(
  argv: readonly string[],
  dependencies: PrintEntryDependencies,
): Promise<PrintEntryResult> {
  const parsed = parseTask(argv, dependencies.io);
  if (typeof parsed !== "string") return parsed;
  try {
    const session = await dependencies.agent.createSession({ workspace: dependencies.workspace });
    const handle = await session.startRun({ task: parsed });
    let projection = reduceProjection(undefined, await session.snapshot());
    const consumeEvents = (async () => {
      for await (const event of handle.events()) projection = reduceProjection(projection, event);
    })();
    const report = await handle.finished;
    await consumeEvents;
    const terminal = projection.runs[report.runId]?.report ?? report;
    if (terminal.finalAnswer) dependencies.io.stdout(`${terminal.finalAnswer}\n`);
    if (terminal.status === "completed") {
      return { exitCode: 0, status: "completed", report: terminal };
    }
    if (terminal.status === "aborted") {
      dependencies.io.stderr(`Run aborted: ${terminal.terminationReason}\n`);
      return { exitCode: 130, status: "aborted", report: terminal };
    }
    dependencies.io.stderr(`Run ${terminal.status}: ${terminal.terminationReason}\n`);
    return { exitCode: 1, status: terminal.status, report: terminal };
  } catch (error) {
    dependencies.io.stderr(
      `无法启动 Run: ${error instanceof Error ? error.message : "未知 application failure"}\n`,
    );
    return { exitCode: 1, status: "start_error" };
  }
}

export function createPrintInteractionMode(): InteractionMode {
  return {
    descriptor: { id: "print", displayName: "Print" },
    async run(context) {
      return runPrintEntry(context.argv, {
        agent: context.agent,
        workspace: context.workspace,
        io: context.io,
      });
    },
  };
}
