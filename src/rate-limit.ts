/**
 * Calls per user per time window.
 *
 * The default store lives in the memory of one process. On serverless
 * platforms every instance has its own memory, so the real limit is "per user
 * per instance": plug a shared store (Redis, your database) when that matters.
 * Count inside the same write that records the call, so two calls arriving
 * together on the last free slot do not both get through.
 */
export type RateLimitDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RateLimitStore {
  /** Records one call for `key` and says whether it fits in the window. */
  hit(key: string, limit: number, windowMs: number, now: number): Promise<RateLimitDecision> | RateLimitDecision;
}

export interface RateLimitOptions {
  /** Calls allowed per user in the window. Default 60. */
  limit?: number;
  /** Window length in milliseconds. Default 60 000. */
  windowMs?: number;
  /** Where calls are counted. Default: `memoryRateLimitStore()`. */
  store?: RateLimitStore;
}

/** A sliding-window store in process memory. */
export function memoryRateLimitStore(): RateLimitStore {
  const calls = new Map<string, number[]>();
  return {
    hit(key, limit, windowMs, now) {
      const recent = (calls.get(key) ?? []).filter((t) => t > now - windowMs);
      if (recent.length >= limit) {
        calls.set(key, recent);
        const oldest = recent[0] ?? now;
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
      }
      recent.push(now);
      calls.set(key, recent);
      return { ok: true };
    },
  };
}
