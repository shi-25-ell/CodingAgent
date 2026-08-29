import type { WorkspaceBinding } from "@coding-agent/agent";
import type { CodingAgent } from "../app/coding-agent.js";

export interface ModeDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly interactive?: boolean;
}

export interface ModeIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface ModeContext {
  readonly agent: CodingAgent;
  readonly workspace: WorkspaceBinding;
  readonly argv: readonly string[];
  readonly io: ModeIo;
  readonly signal: AbortSignal;
}

export interface ModeExit {
  readonly exitCode: number;
  readonly status: string;
}

export interface InteractionMode {
  readonly descriptor: ModeDescriptor;
  run(context: ModeContext): Promise<ModeExit>;
}

export interface ModeRegistration {
  dispose(): void;
}

export interface ModeRegistry {
  register(mode: InteractionMode): ModeRegistration;
  resolve(id: string): InteractionMode;
  list(): readonly ModeDescriptor[];
}

export class InteractionModeRegistry implements ModeRegistry {
  readonly #modes = new Map<string, InteractionMode>();

  constructor(modes: readonly InteractionMode[] = []) {
    for (const mode of modes) this.register(mode);
  }

  register(mode: InteractionMode): ModeRegistration {
    if (mode.descriptor.id.trim().length === 0) throw new TypeError("mode id 不能为空");
    if (this.#modes.has(mode.descriptor.id)) {
      throw new TypeError(`duplicate interaction mode: ${mode.descriptor.id}`);
    }
    this.#modes.set(mode.descriptor.id, mode);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        if (this.#modes.get(mode.descriptor.id) === mode) this.#modes.delete(mode.descriptor.id);
      },
    };
  }

  resolve(id: string): InteractionMode {
    const mode = this.#modes.get(id);
    if (!mode) throw new RangeError(`unknown interaction mode: ${id}`);
    return mode;
  }

  list(): readonly ModeDescriptor[] {
    return Object.freeze(
      [...this.#modes.values()].map((mode) => Object.freeze({ ...mode.descriptor })),
    );
  }
}
