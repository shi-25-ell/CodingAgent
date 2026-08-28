import type { JsonObject } from "@coding-agent/model";

export interface LocalFileInfo {
  readonly directory: boolean;
  readonly symbolicLink: boolean;
  readonly device: number;
  readonly inode: number;
}

export interface LocalDirectoryEntry {
  readonly name: string;
  readonly directory: boolean;
  readonly file: boolean;
  readonly symbolicLink: boolean;
}

export interface LocalAtomicFile extends AsyncDisposable {
  write(content: string): Promise<void>;
  sync(): Promise<void>;
  stat(): Promise<Pick<LocalFileInfo, "device" | "inode">>;
}

export interface LocalFilesystemPort {
  captureWorkspaceRoot(input: string): string;
  realpath(input: string): Promise<string>;
  inspect(input: string): Promise<LocalFileInfo>;
  read(input: string, signal?: AbortSignal): Promise<Uint8Array>;
  list(input: string): Promise<readonly LocalDirectoryEntry[]>;
  openExclusive(input: string): Promise<LocalAtomicFile>;
  rename(source: string, destination: string): Promise<void>;
  remove(input: string): Promise<void>;
}

export interface LocalProcessRequest {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly inlineOutputBytes: number;
  readonly registeredSecrets: readonly string[];
}

export interface LocalProcessResult {
  readonly status: "succeeded" | "rejected" | "failed" | "timed_out" | "output_limit" | "cancelled";
  readonly modelContent: string;
  readonly effectState: "unknown";
  readonly abortObserved: boolean;
  readonly artifactBytes?: Uint8Array;
  readonly evidence?: JsonObject;
  readonly infrastructureFailure?: { readonly code: string; readonly message: string };
}

export interface LocalProcessPort {
  run(request: LocalProcessRequest): Promise<LocalProcessResult>;
}

export interface LocalGitResult {
  readonly status: "succeeded" | "failed" | "output_limit" | "cancelled";
  readonly modelContent: string;
  readonly artifactBytes?: Uint8Array;
  readonly evidence?: JsonObject;
  readonly abortObserved: boolean;
}

export interface LocalGitPort {
  run(
    root: string,
    arguments_: readonly string[],
    signal: AbortSignal,
    maximumBytes: number,
    registeredSecrets: readonly string[],
  ): Promise<LocalGitResult>;
}

export interface LocalExecutionPorts {
  readonly filesystem: LocalFilesystemPort;
  readonly process: LocalProcessPort;
  readonly git: LocalGitPort;
}
