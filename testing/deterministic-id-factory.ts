import type { IdFactory } from "../session/ledger.js";

export class DeterministicIdFactory implements IdFactory {
  private readonly sequences = new Map<string, number>();

  public next(namespace: string): string {
    if (!/^[a-z][a-z0-9-]*$/.test(namespace)) {
      throw new Error(`invalid ID namespace: ${namespace}`);
    }
    const sequence = (this.sequences.get(namespace) ?? 0) + 1;
    this.sequences.set(namespace, sequence);
    return `${namespace}-${sequence.toString().padStart(4, "0")}`;
  }
}
