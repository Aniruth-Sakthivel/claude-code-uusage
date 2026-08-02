/**
 * Exponential backoff retry, for flaky *external* services only (e.g.
 * Supabase Admin API calls in core/supabase-admin.ts). Never apply this to
 * validation errors or anything under the caller's own control — retrying a
 * malformed request just delays the inevitable identical failure.
 *
 * Delays: 1s, 2s, 4s (base * 2^(attempt-1)), capped at 3 attempts by default.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  retries?: number;
  /** Delay before the 2nd attempt; doubles each subsequent attempt. Default 1000ms. */
  baseDelayMs?: number;
  /** Return false to fail immediately without retrying (e.g. a non-transient
   * error). Default: retry every error. */
  shouldRetry?: (err: unknown) => boolean;
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { retries = 3, baseDelayMs = 1000, shouldRetry = () => true } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === retries || !shouldRetry(err)) throw err;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  // Unreachable (the loop always returns or throws), but keeps TypeScript's
  // control-flow analysis happy without an `as T` cast.
  throw lastError;
}
