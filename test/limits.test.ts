import { describe, expect, it } from "vitest";
import { ToolTimeoutError, memoryRateLimitStore, withTimeout } from "../src/index.js";

describe("rate limit store", () => {
  it("allows `limit` calls per window, then says when to retry; other keys are not affected", async () => {
    const store = memoryRateLimitStore();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(await store.hit("alice", 3, 60_000, t0 + i)).toEqual({ ok: true });
    expect(await store.hit("alice", 3, 60_000, t0 + 10_000)).toEqual({ ok: false, retryAfterSeconds: 50 });
    expect(await store.hit("bob", 3, 60_000, t0 + 10_000)).toEqual({ ok: true });
    expect(await store.hit("alice", 3, 60_000, t0 + 60_001)).toEqual({ ok: true });
  });

  it("refused calls do not take a slot", async () => {
    const store = memoryRateLimitStore();
    expect(await store.hit("a", 1, 1000, 0)).toEqual({ ok: true });
    for (let i = 1; i < 10; i++) expect((await store.hit("a", 1, 1000, i * 10)).ok).toBe(false);
    expect(await store.hit("a", 1, 1000, 1001)).toEqual({ ok: true });
  });
});

describe("withTimeout", () => {
  it("returns the result when the work is in time", async () => {
    expect(await withTimeout(1000, undefined, async () => 42)).toBe(42);
  });

  it("rejects at the deadline and aborts the signal, even if the work ignores it", async () => {
    let seen: AbortSignal | null = null;
    const started = Date.now();
    await expect(
      withTimeout(100, undefined, (signal) => {
        seen = signal;
        return new Promise(() => {});
      }),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen!.aborted).toBe(true);
  });

  it("a cancelled parent aborts the work", async () => {
    const parent = new AbortController();
    const p = withTimeout(10_000, parent.signal, (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")))));
    parent.abort();
    await expect(p).rejects.toThrow("cancelled");
  });
});
