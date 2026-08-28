import type { Clock, IdFactory } from "../contracts/primitives.js";

export class ManualClock implements Clock {
  #current: number;

  constructor(initial = 0) {
    if (!Number.isFinite(initial)) throw new TypeError("initial time 必须有限");
    this.#current = initial;
  }

  now(): number {
    return this.#current;
  }

  advance(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new TypeError("advance milliseconds 不能为负且必须有限");
    }
    this.#current += milliseconds;
  }
}

export class SequentialIdFactory implements IdFactory {
  readonly #counters = new Map<string, number>();

  next(scope: Parameters<IdFactory["next"]>[0]): string {
    const value = (this.#counters.get(scope) ?? 0) + 1;
    this.#counters.set(scope, value);
    return `${scope}-${value}`;
  }
}

export class ManualGate {
  readonly #blocked = new Set<(result: "opened" | "aborted") => void>();
  readonly #observers = new Set<() => void>();
  #open = false;

  wait(signal?: AbortSignal): Promise<"opened" | "aborted"> {
    if (this.#open) return Promise.resolve("opened");
    if (signal?.aborted) return Promise.resolve("aborted");
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: "opened" | "aborted"): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.#blocked.delete(settle);
        resolve(result);
      };
      const onAbort = (): void => settle("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#blocked.add(settle);
      for (const observer of this.#observers) observer();
      this.#observers.clear();
    });
  }

  waitUntilBlocked(): Promise<void> {
    if (this.#blocked.size > 0) return Promise.resolve();
    return new Promise((resolve) => this.#observers.add(resolve));
  }

  blockedCount(): number {
    return this.#blocked.size;
  }

  open(): void {
    if (this.#open) return;
    this.#open = true;
    for (const settle of [...this.#blocked]) settle("opened");
  }
}
