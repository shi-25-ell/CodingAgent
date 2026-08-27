import { describe, expect, it } from "vitest";
import { ScriptedModelAdapter } from "../../model/scripted-model-adapter.js";
import { DeterministicIdFactory } from "../../testing/deterministic-id-factory.js";
import { ManualClock } from "../../testing/manual-clock.js";
import { ManualGate } from "../../testing/manual-gate.js";

describe("deterministic test infrastructure", () => {
  it("creates stable monotonic IDs per namespace", () => {
    const ids = new DeterministicIdFactory();

    expect([ids.next("session"), ids.next("run"), ids.next("session")]).toEqual([
      "session-0001",
      "run-0001",
      "session-0002",
    ]);
  });

  it("advances delayed model events only when the manual clock advances", async () => {
    const clock = new ManualClock(1_000);
    const adapter = new ScriptedModelAdapter(
      [
        {
          expectedRequest: { instructions: "system", lastUserText: "hello" },
          emissions: [
            { event: { type: "turn_started" } },
            {
              delayMs: 10,
              event: {
                type: "turn_failed",
                failure: { category: "network", retryable: true, message: "reset" },
              },
            },
          ],
        },
      ],
      clock,
    );
    const stream = adapter
      .stream(
        {
          instructions: "system",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
          toolChoice: "none",
        },
        { signal: new AbortController().signal },
      )
      [Symbol.asyncIterator]();

    await expect(stream.next()).resolves.toEqual({ done: false, value: { type: "turn_started" } });
    const terminal = stream.next();
    expect(clock.pendingSleeps).toBe(1);
    clock.advanceBy(10);
    await expect(terminal).resolves.toMatchObject({
      done: false,
      value: { type: "turn_failed", failure: { category: "network" } },
    });
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });

    adapter.assertComplete();
    clock.assertIdle();
  });

  it("fails when a request does not match the next FIFO step", async () => {
    const adapter = new ScriptedModelAdapter([
      {
        expectedRequest: { lastUserText: "expected" },
        emissions: [{ event: { type: "turn_started" } }],
      },
    ]);

    const consume = async () => {
      for await (const _event of adapter.stream(
        {
          instructions: "",
          messages: [{ role: "user", content: "actual" }],
          tools: [],
          toolChoice: "none",
        },
        { signal: new AbortController().signal },
      )) {
        // Consume the stream so request validation runs.
      }
    };

    await expect(consume()).rejects.toThrow("expected last user text");
  });

  it("holds a scripted emission behind an explicit promise gate", async () => {
    const gate = new ManualGate();
    const adapter = new ScriptedModelAdapter([
      {
        emissions: [
          { event: { type: "turn_started" } },
          {
            gate,
            event: {
              type: "turn_failed",
              failure: { category: "network", retryable: false, message: "after gate" },
            },
          },
        ],
      },
    ]);
    const iterator = adapter
      .stream(
        { instructions: "", messages: [], tools: [], toolChoice: "none" },
        { signal: new AbortController().signal },
      )
      [Symbol.asyncIterator]();
    await iterator.next();

    const terminal = iterator.next();
    expect(gate.pendingWaiters).toBe(1);
    gate.open();
    await expect(terminal).resolves.toMatchObject({
      value: { type: "turn_failed", failure: { message: "after gate" } },
    });
    await iterator.next();

    gate.assertIdle();
    adapter.assertComplete();
  });
});
