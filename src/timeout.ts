/** Thrown by `withTimeout` when the work did not finish in time. */
export class ToolTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = "ToolTimeoutError";
  }
}

/**
 * Runs `work` with a deadline. The signal handed to `work` aborts when the
 * deadline passes or when `parent` aborts (the client cancelled), so a data
 * adapter can stop its queries instead of running on for nobody.
 *
 * The promise settles at the deadline even if `work` ignores the signal: a
 * slow database never keeps the HTTP response open.
 */
export async function withTimeout<T>(
  ms: number,
  parent: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new ToolTimeoutError(ms);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}
