export interface ReplayEventStreamOptions<T> {
  readonly coalescingKey?: (item: T) => string | undefined;
  readonly maximumCoalescedKeys?: number;
}

interface CoalescedItem<T> {
  readonly item: T;
  readonly revision: number;
  readonly ordinal: number;
}

/** Non-lossy replay for semantic items plus bounded latest-value delivery for keyed progress. */
export class ReplayEventStream<T> {
  readonly #items: T[] = [];
  readonly #coalesced = new Map<string, CoalescedItem<T>>();
  readonly #waiters = new Set<() => void>();
  readonly #coalescingKey: ((item: T) => string | undefined) | undefined;
  readonly #maximumCoalescedKeys: number;
  #revision = 0;
  #ordinal = 0;
  #closed = false;

  constructor(options: ReplayEventStreamOptions<T> = {}) {
    this.#coalescingKey = options.coalescingKey;
    this.#maximumCoalescedKeys = options.maximumCoalescedKeys ?? 64;
    if (!Number.isSafeInteger(this.#maximumCoalescedKeys) || this.#maximumCoalescedKeys < 1) {
      throw new TypeError("maximumCoalescedKeys 必须是正安全整数");
    }
  }

  publish(item: T): void {
    if (this.#closed) return;
    const key = this.#coalescingKey?.(item);
    if (key === undefined) {
      this.#items.push(item);
    } else {
      this.#revision += 1;
      this.#ordinal += 1;
      if (!this.#coalesced.has(key) && this.#coalesced.size >= this.#maximumCoalescedKeys) {
        let oldestKey: string | undefined;
        let oldestOrdinal = Number.POSITIVE_INFINITY;
        for (const [candidate, value] of this.#coalesced) {
          if (value.ordinal < oldestOrdinal) {
            oldestKey = candidate;
            oldestOrdinal = value.ordinal;
          }
        }
        if (oldestKey !== undefined) this.#coalesced.delete(oldestKey);
      }
      this.#coalesced.set(key, { item, revision: this.#revision, ordinal: this.#ordinal });
    }
    this.#wake();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake();
  }

  events(): AsyncIterable<T> {
    const stream = this;
    let index = 0;
    const revisions = new Map<string, number>();
    const pending: CoalescedItem<T>[] = [];
    let disposed = false;
    let waiting: (() => void) | undefined;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      if (waiting) {
        stream.#waiters.delete(waiting);
        const wake = waiting;
        waiting = undefined;
        wake();
      }
    };
    const iterator: AsyncIterableIterator<T> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      async next(): Promise<IteratorResult<T>> {
        while (true) {
          if (disposed) return { done: true, value: undefined };
          const semantic = stream.#items[index];
          if (semantic !== undefined) {
            index += 1;
            return { done: false, value: semantic };
          }
          const progress = pending.shift();
          if (progress) return { done: false, value: progress.item };
          pending.push(
            ...[...stream.#coalesced.entries()]
              .filter(([, value]) => value.revision > 0)
              .map(([key, value]) => ({ key, value }))
              .filter(({ key, value }) => value.revision > (revisions.get(key) ?? 0))
              .sort((left, right) => left.value.ordinal - right.value.ordinal)
              .map(({ key, value }) => {
                revisions.set(key, value.revision);
                return value;
              }),
          );
          if (pending.length > 0) continue;
          if (stream.#closed) {
            dispose();
            return { done: true, value: undefined };
          }
          await new Promise<void>((resolve) => {
            waiting = () => {
              waiting = undefined;
              resolve();
            };
            stream.#waiters.add(waiting);
          });
        }
      },
      async return(): Promise<IteratorResult<T>> {
        dispose();
        return { done: true, value: undefined };
      },
    };
    return iterator;
  }

  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }
}
