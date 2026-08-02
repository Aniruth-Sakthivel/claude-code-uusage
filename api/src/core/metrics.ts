/**
 * Lightweight in-process monitoring.
 *
 * Deliberately not Prometheus/StatsD: this is a small, single-service app
 * with no metrics backend to scrape it, and standing one up would be
 * infrastructure disproportionate to what's here (same reasoning as skipping
 * Redis in cache.ts). This gives an operator something to look at via
 * `/api/v1/metrics` without adding a dependency.
 *
 * Like the cache, this is per-warm-instance: a serverless cold start resets
 * these counters. Fine for "is this instance healthy right now", not a
 * substitute for real aggregated observability if this app ever needs one.
 *
 * NOTE: "Active WebSocket connections" (in the original spec) isn't included
 * here on purpose — the WS server (src/ws/server.ts) is a *separate process*
 * from this Fastify app with no shared memory or Redis to report through, so
 * this process genuinely cannot see that number. Faking a value would be
 * worse than omitting it; see ws/server.ts's own `hub.size` if that's needed
 * for a future cross-process metric.
 */

const MAX_SAMPLES = 500;

class MetricsRegistry {
  private requestsTotal = 0;
  private errorsTotal = 0;
  private readonly statusCounts = new Map<number, number>();
  private readonly durationsMs: number[] = [];

  recordRequest(statusCode: number, durationMs: number): void {
    this.requestsTotal++;
    if (statusCode >= 500) this.errorsTotal++;
    this.statusCounts.set(statusCode, (this.statusCounts.get(statusCode) ?? 0) + 1);
    this.durationsMs.push(durationMs);
    if (this.durationsMs.length > MAX_SAMPLES) this.durationsMs.shift();
  }

  private percentile(p: number): number {
    if (this.durationsMs.length === 0) return 0;
    const sorted = [...this.durationsMs].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx]!;
  }

  snapshot() {
    const mem = process.memoryUsage();
    return {
      requests: {
        total: this.requestsTotal,
        errors: this.errorsTotal,
        errorRate: this.requestsTotal === 0 ? 0 : this.errorsTotal / this.requestsTotal,
        byStatus: Object.fromEntries(this.statusCounts),
      },
      latencyMs: {
        p50: this.percentile(50),
        p95: this.percentile(95),
        p99: this.percentile(99),
        sampleSize: this.durationsMs.length,
      },
      memory: {
        rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
        heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
        heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
      },
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  reset(): void {
    this.requestsTotal = 0;
    this.errorsTotal = 0;
    this.statusCounts.clear();
    this.durationsMs.length = 0;
  }
}

export const metrics = new MetricsRegistry();
