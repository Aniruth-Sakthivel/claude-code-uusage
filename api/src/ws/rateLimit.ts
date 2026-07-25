/**
 * Per-connection token bucket.
 *
 * Bounds how many messages one socket can push per second so a misbehaving or
 * compromised agent can't flood the process (CPU on JSON/zod parsing, memory
 * on the outbound queue, DB load on ingest) — a resource-exhaustion vector a
 * pure "authenticated = trusted" model would miss.
 */

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** Returns true and consumes one token if available, else false. */
  tryConsume(): boolean {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
      this.lastRefill = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
