export type ComposerDeliveryMode = "steering" | "follow_up";
export type ComposerHistoryDirection = "previous" | "next";

export interface PreparedComposerPaste {
  readonly text: string;
  readonly lineCount: number;
  readonly characterCount: number;
  readonly large: boolean;
  readonly placeholder?: string;
}

export interface ComposerVisualBoundary {
  readonly visualRow: number;
  readonly visualLineCount: number;
  readonly hasSelection: boolean;
}

export function normalizeComposerPaste(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function prepareComposerPaste(value: string): PreparedComposerPaste {
  const text = normalizeComposerPaste(value);
  const lineCount = text.split("\n").length;
  const characterCount = [...text].length;
  const large = lineCount >= 3 || characterCount > 150;
  return Object.freeze({
    text,
    lineCount,
    characterCount,
    large,
    ...(large ? { placeholder: `[Pasted ${lineCount} lines · ${characterCount} chars]` } : {}),
  });
}

function atHistoryBoundary(
  direction: ComposerHistoryDirection,
  boundary: ComposerVisualBoundary,
): boolean {
  if (boundary.hasSelection || boundary.visualLineCount < 1) return false;
  return direction === "previous"
    ? boundary.visualRow === 0
    : boundary.visualRow === boundary.visualLineCount - 1;
}

/** UI-local command history; durable Session state never owns draft navigation. */
export class ComposerHistory {
  readonly #entries: string[] = [];
  #index = 0;
  #draft = "";

  constructor(entries: readonly string[] = []) {
    for (const entry of entries) this.record(entry);
    this.#index = this.#entries.length;
  }

  record(value: string): void {
    if (value.length === 0 || this.#entries.at(-1) === value) return;
    this.#entries.push(value);
    this.#index = this.#entries.length;
    this.#draft = "";
  }

  navigate(
    direction: ComposerHistoryDirection,
    currentValue: string,
    boundary: ComposerVisualBoundary,
  ): string | undefined {
    if (!atHistoryBoundary(direction, boundary) || this.#entries.length === 0) return undefined;
    if (direction === "previous") {
      if (this.#index === this.#entries.length) this.#draft = currentValue;
      if (this.#index === 0) return this.#entries[0];
      this.#index -= 1;
      return this.#entries[this.#index];
    }
    if (this.#index >= this.#entries.length) return this.#draft;
    this.#index += 1;
    return this.#index === this.#entries.length ? this.#draft : this.#entries[this.#index];
  }

  resetNavigation(): void {
    this.#index = this.#entries.length;
    this.#draft = "";
  }

  values(): readonly string[] {
    return Object.freeze([...this.#entries]);
  }
}

export interface ComposerSubmitGateOptions {
  readonly defer?: (callback: () => void) => void;
}

/** Double deferral lets terminal IME composition reach Textarea.plainText before submit. */
export class ComposerSubmitGate {
  readonly #defer: (callback: () => void) => void;
  #pending = false;

  constructor(options: ComposerSubmitGateOptions = {}) {
    this.#defer = options.defer ?? queueMicrotask;
  }

  trigger(readText: () => string, submit: (text: string) => void | Promise<void>): boolean {
    if (this.#pending) return false;
    this.#pending = true;
    this.#defer(() => {
      this.#defer(() => {
        void Promise.resolve(submit(readText())).finally(() => {
          this.#pending = false;
        });
      });
    });
    return true;
  }

  get pending(): boolean {
    return this.#pending;
  }
}
