import { describe, expect, it, vi } from "vitest";

import { TokenBucket } from "./rateLimit.js";

describe("TokenBucket", () => {
  it("allows up to capacity bursts", () => {
    const bucket = new TokenBucket(5, 1);
    for (let i = 0; i < 5; i++) expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it("refills over time", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1000);
    const bucket = new TokenBucket(2, 1); // 1 token/sec
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);

    now.mockReturnValue(1000 + 1500); // +1.5s -> +1 token
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);

    now.mockRestore();
  });

  it("never exceeds capacity even after a long gap", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(0);
    const bucket = new TokenBucket(3, 1);
    now.mockReturnValue(1_000_000); // huge gap
    let consumed = 0;
    while (bucket.tryConsume()) consumed++;
    expect(consumed).toBe(3);
    now.mockRestore();
  });
});
