import type { RunId } from "@coding-agent/agent";
import type {
  CodingEvent,
  CodingProgressEvent,
  CodingProgressPayload,
  CodingSemanticEvent,
  CodingSemanticPayload,
} from "./coding-events.js";

export interface CodingEventCursor {
  readonly semanticSequence: number;
}

export interface CodingEventChannelDiagnostics {
  readonly semanticCount: number;
  readonly pendingProgressCount: number;
  readonly evictedProgressCount: number;
  readonly subscriberCount: number;
  readonly closed: boolean;
}

interface ProgressSlot {
  readonly event: CodingProgressEvent;
  readonly ordinal: number;
}

export class CodingEventChannel {
  readonly #runId: RunId;
  readonly #maximumProgressKeys: number;
  readonly #semantic: CodingSemanticEvent[] = [];
  readonly #progress = new Map<string, ProgressSlot>();
  readonly #waiters = new Set<() => void>();
  #semanticSequence = 0;
  #progressRevision = 0;
  #progressOrdinal = 0;
  #evictedProgressCount = 0;
  #subscriberCount = 0;
  #closed = false;

  constructor(runId: RunId, options: { readonly maximumProgressKeys?: number } = {}) {
    this.#runId = runId;
    this.#maximumProgressKeys = options.maximumProgressKeys ?? 64;
    if (!Number.isSafeInteger(this.#maximumProgressKeys) || this.#maximumProgressKeys < 1) {
      throw new TypeError("maximumProgressKeys 必须是正安全整数");
    }
  }

  cursor(): CodingEventCursor {
    return { semanticSequence: this.#semanticSequence };
  }

  checkpointEvents(cursor: CodingEventCursor = this.cursor()): readonly CodingEvent[] {
    return Object.freeze([
      ...this.#semantic.filter((event) => event.sequence <= cursor.semanticSequence),
      ...[...this.#progress.values()]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({ event }) => event),
    ]);
  }

  publishSemantic(payload: CodingSemanticPayload): CodingSemanticEvent | undefined {
    if (this.#closed) return undefined;
    this.#semanticSequence += 1;
    const event = {
      version: 1,
      category: "semantic",
      runId: this.#runId,
      sequence: this.#semanticSequence,
      eventId: `${this.#runId}:${this.#semanticSequence}`,
      ...payload,
    } as unknown as CodingSemanticEvent;
    this.#semantic.push(event);
    this.#wake();
    return event;
  }

  publishProgress(payload: CodingProgressPayload): CodingProgressEvent | undefined {
    if (this.#closed) return undefined;
    this.#progressRevision += 1;
    this.#progressOrdinal += 1;
    const event = {
      version: 1,
      category: "progress",
      runId: this.#runId,
      revision: this.#progressRevision,
      ...payload,
    } as unknown as CodingProgressEvent;
    if (!this.#progress.has(event.key) && this.#progress.size >= this.#maximumProgressKeys) {
      let oldestKey: string | undefined;
      let oldestOrdinal = Number.POSITIVE_INFINITY;
      for (const [key, slot] of this.#progress) {
        if (slot.ordinal < oldestOrdinal) {
          oldestKey = key;
          oldestOrdinal = slot.ordinal;
        }
      }
      if (oldestKey !== undefined) {
        this.#progress.delete(oldestKey);
        this.#evictedProgressCount += 1;
      }
    }
    this.#progress.set(event.key, { event, ordinal: this.#progressOrdinal });
    this.#wake();
    return event;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake();
  }

  diagnostics(): CodingEventChannelDiagnostics {
    return {
      semanticCount: this.#semantic.length,
      pendingProgressCount: this.#progress.size,
      evictedProgressCount: this.#evictedProgressCount,
      subscriberCount: this.#subscriberCount,
      closed: this.#closed,
    };
  }

  events(cursor: CodingEventCursor = { semanticSequence: 0 }): AsyncIterable<CodingEvent> {
    let semanticIndex = this.#semantic.findIndex(
      (event) => event.sequence > cursor.semanticSequence,
    );
    if (semanticIndex < 0) semanticIndex = this.#semantic.length;
    const progressRevisions = new Map<string, number>();
    const pendingProgress: CodingProgressEvent[] = [];
    let disposed = false;
    let waiting: (() => void) | undefined;
    this.#subscriberCount += 1;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      this.#subscriberCount -= 1;
      if (waiting) {
        this.#waiters.delete(waiting);
        const wake = waiting;
        waiting = undefined;
        wake();
      }
    };
    const iterator: AsyncIterableIterator<CodingEvent> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      async next(): Promise<IteratorResult<CodingEvent>> {
        while (true) {
          if (disposed) return { done: true, value: undefined };
          let semantic = thisChannel.#semantic[semanticIndex];
          while (semantic && semantic.sequence <= cursor.semanticSequence) {
            semanticIndex += 1;
            semantic = thisChannel.#semantic[semanticIndex];
          }
          if (semantic) {
            semanticIndex += 1;
            return { done: false, value: semantic };
          }
          const queuedProgress = pendingProgress.shift();
          if (queuedProgress) {
            progressRevisions.set(queuedProgress.key, queuedProgress.revision);
            return { done: false, value: queuedProgress };
          }
          pendingProgress.push(
            ...[...thisChannel.#progress.values()]
              .filter(({ event }) => event.revision > (progressRevisions.get(event.key) ?? 0))
              .sort((left, right) => left.ordinal - right.ordinal)
              .map(({ event }) => event),
          );
          if (pendingProgress.length > 0) continue;
          if (thisChannel.#closed) {
            dispose();
            return { done: true, value: undefined };
          }
          await new Promise<void>((resolve) => {
            waiting = () => {
              waiting = undefined;
              resolve();
            };
            thisChannel.#waiters.add(waiting);
          });
        }
      },
      async return(): Promise<IteratorResult<CodingEvent>> {
        dispose();
        return { done: true, value: undefined };
      },
    };
    const thisChannel = this;
    return iterator;
  }

  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }
}
