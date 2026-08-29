/**
 * `Object.freeze(Set)` 不会冻结 Set 的内部 slots。这个 view 只暴露
 * ReadonlySet Interface，并把可变 Set 封装在不可达的 private field 中。
 */
class ImmutableReadonlySet<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;

  constructor(values?: Iterable<T>) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: T): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[T, T]> {
    return this.#values.entries();
  }

  keys(): SetIterator<T> {
    return this.#values.keys();
  }

  values(): SetIterator<T> {
    return this.#values.values();
  }

  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }
}

export function immutableReadonlySet<T>(values?: Iterable<T>): ReadonlySet<T> {
  return new ImmutableReadonlySet(values);
}
