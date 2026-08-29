import { type CliRenderer, type CliRendererConfig, createCliRenderer } from "@opentui/core";
import { productIdentity } from "../../product/index.js";

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

export async function createProductionOpenTuiRenderer(
  options: OpenTuiRendererOptions = {},
): Promise<CliRenderer> {
  const renderer = await createCliRenderer({
    ...options.config,
    ...(options.stdin ? { stdin: options.stdin } : {}),
    ...(options.stdout ? { stdout: options.stdout } : {}),
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
