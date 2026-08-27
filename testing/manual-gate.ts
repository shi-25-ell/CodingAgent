interface GateWaiter {
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class ManualGate {
  private opened = false;
  private readonly waiters = new Set<GateWaiter>();

  public get pendingWaiters(): number {
    return this.waiters.size;
  }

  public wait(signal: AbortSignal): Promise<void> {
    if (this.opened) {
      return Promise.resolve();
    }
    if (signal.aborted) {
      return Promise.reject(abortError());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: GateWaiter = {
        signal,
        onAbort: () => {
          this.settle(waiter);
          reject(abortError());
        },
        resolve,
        reject,
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  public open(): void {
    if (this.opened) {
      throw new Error("manual gate is already open");
    }
    this.opened = true;
    for (const waiter of [...this.waiters]) {
      this.settle(waiter);
      waiter.resolve();
    }
  }

  public assertIdle(): void {
    if (!this.opened || this.waiters.size !== 0) {
      throw new Error(
        `manual gate is not settled: opened=${this.opened}, waiters=${this.waiters.size}`,
      );
    }
  }

  private settle(waiter: GateWaiter): void {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    this.waiters.delete(waiter);
  }
}

function abortError(): Error {
  const error = new Error("operation aborted while waiting for a gate");
  error.name = "AbortError";
  return error;
}
