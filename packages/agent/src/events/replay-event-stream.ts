export class ReplayEventStream<T> {
  readonly #items: T[] = [];
  readonly #waiters = new Set<() => void>();
  #closed = false;

  publish(item: T): void {
    if (this.#closed) return;
    this.#items.push(item);
    this.#wake();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#wake();
  }

  async *events(): AsyncIterable<T> {
    let index = 0;
    while (true) {
      while (index < this.#items.length) {
        const value = this.#items[index];
        index += 1;
        if (value !== undefined) yield value;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#waiters.add(resolve));
    }
  }

  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }
}
