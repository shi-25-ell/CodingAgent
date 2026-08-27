interface Sleeper {
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class ManualClock {
  private currentTime: number;
  private readonly sleepers = new Set<Sleeper>();

  public constructor(initialTime = 0) {
    this.currentTime = initialTime;
  }

  public now(): number {
    return this.currentTime;
  }

  public get pendingSleeps(): number {
    return this.sleepers.size;
  }

  public sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      return Promise.reject(new Error(`invalid delay: ${delayMs}`));
    }
    if (signal.aborted) {
      return Promise.reject(abortError());
    }
    if (delayMs === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const sleeper: Sleeper = {
        deadline: this.currentTime + delayMs,
        signal,
        onAbort: () => {
          this.settle(sleeper);
          reject(abortError());
        },
        resolve,
        reject,
      };
      signal.addEventListener("abort", sleeper.onAbort, { once: true });
      this.sleepers.add(sleeper);
    });
  }

  public advanceBy(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(`invalid clock advance: ${durationMs}`);
    }
    this.currentTime += durationMs;
    for (const sleeper of [...this.sleepers]) {
      if (sleeper.deadline <= this.currentTime) {
        this.settle(sleeper);
        sleeper.resolve();
      }
    }
  }

  public assertIdle(): void {
    if (this.sleepers.size !== 0) {
      throw new Error(`manual clock has ${this.sleepers.size} pending sleep(s)`);
    }
  }

  private settle(sleeper: Sleeper): void {
    sleeper.signal.removeEventListener("abort", sleeper.onAbort);
    this.sleepers.delete(sleeper);
  }
}

function abortError(): Error {
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}
