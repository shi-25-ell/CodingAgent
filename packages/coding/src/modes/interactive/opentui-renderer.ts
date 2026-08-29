import { type CliRenderer, type CliRendererConfig, createCliRenderer } from "@opentui/core";
import { productIdentity } from "../../product/index.js";
import {
  type InteractiveTerminalDiagnosticCode,
  inspectInteractiveTerminal,
} from "./terminal-presentation.js";

export interface OpenTuiRendererOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly config?: Omit<
    CliRendererConfig,
    | "stdin"
    | "stdout"
    | "screenMode"
    | "exitOnCtrlC"
    | "exitSignals"
    | "clearOnShutdown"
    | "onDestroy"
  >;
  readonly onDestroy?: () => void;
}

export class InteractiveTerminalError extends Error {
  readonly code: InteractiveTerminalDiagnosticCode;

  constructor(code: InteractiveTerminalDiagnosticCode, message: string) {
    super(message);
    this.name = "InteractiveTerminalError";
    this.code = code;
  }
}

export async function createProductionOpenTuiRenderer(
  options: OpenTuiRendererOptions = {},
): Promise<CliRenderer> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const readiness = inspectInteractiveTerminal({
    stdinIsTty: stdin.isTTY === true,
    stdoutIsTty: stdout.isTTY === true,
    stdinSupportsRawMode: typeof stdin.setRawMode === "function",
  });
  if (!readiness.ready && readiness.diagnostic) {
    throw new InteractiveTerminalError(readiness.diagnostic.code, readiness.diagnostic.message);
  }
  const renderer = await createCliRenderer({
    ...options.config,
    stdin,
    stdout,
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    exitSignals: [],
    clearOnShutdown: true,
    useMouse: true,
    autoFocus: true,
    useKittyKeyboard: { disambiguate: true, alternateKeys: true, events: false },
    targetFps: options.config?.targetFps ?? 30,
    maxFps: options.config?.maxFps ?? 60,
    consoleMode: options.config?.consoleMode ?? "disabled",
    ...(options.onDestroy ? { onDestroy: options.onDestroy } : {}),
  });
  renderer.setTerminalTitle(productIdentity.displayName);
  return renderer;
}
