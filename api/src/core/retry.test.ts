import { describe, expect, it, vi } from "vitest";

import { retryWithBackoff } from "./retry.js";

describe("retryWithBackoff", () => {
  it("returns the result immediately on first success, without waiting", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and eventually succeeds", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient 1"))
        .mockRejectedValueOnce(new Error("transient 2"))
        .mockResolvedValueOnce("ok");

      const promise = retryWithBackoff(fn, { retries: 3, baseDelayMs: 1000 });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses exponential backoff delays: 1s, then 2s", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockResolvedValueOnce("ok");

      const promise = retryWithBackoff(fn, { retries: 3, baseDelayMs: 1000 });

      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1); // first attempt, no delay

      await vi.advanceTimersByTimeAsync(999);
      expect(fn).toHaveBeenCalledTimes(1); // not yet — waiting out the 1s backoff
      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledTimes(2); // 1s elapsed -> 2nd attempt

      await vi.advanceTimersByTimeAsync(1999);
      expect(fn).toHaveBeenCalledTimes(2); // not yet — waiting out the 2s backoff
      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledTimes(3); // 2s elapsed -> 3rd attempt

      await expect(promise).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up and throws the last error after exhausting retries", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValue(new Error("always fails"));
      const promise = retryWithBackoff(fn, { retries: 3, baseDelayMs: 10 });
      const assertion = expect(promise).rejects.toThrow("always fails");
      await vi.runAllTimersAsync();
      await assertion;
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry when shouldRetry returns false — fails fast", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent failure"));
    await expect(
      retryWithBackoff(fn, { retries: 3, shouldRetry: () => false }),
    ).rejects.toThrow("permanent failure");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never retries a validation-style error when shouldRetry excludes it", async () => {
    class ValidationLikeError extends Error {}
    const fn = vi.fn().mockRejectedValue(new ValidationLikeError("bad input"));
    await expect(
      retryWithBackoff(fn, {
        retries: 3,
        shouldRetry: (err) => !(err instanceof ValidationLikeError),
      }),
    ).rejects.toBeInstanceOf(ValidationLikeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
