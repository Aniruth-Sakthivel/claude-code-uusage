import { beforeEach, describe, expect, it } from "vitest";

import { metrics } from "./metrics.js";

describe("MetricsRegistry", () => {
  beforeEach(() => {
    metrics.reset();
  });

  it("starts at zero", () => {
    const snap = metrics.snapshot();
    expect(snap.requests.total).toBe(0);
    expect(snap.requests.errors).toBe(0);
    expect(snap.requests.errorRate).toBe(0);
    expect(snap.latencyMs.sampleSize).toBe(0);
  });

  it("counts requests and buckets by status code", () => {
    metrics.recordRequest(200, 10);
    metrics.recordRequest(200, 20);
    metrics.recordRequest(404, 5);
    const snap = metrics.snapshot();
    expect(snap.requests.total).toBe(3);
    expect(snap.requests.byStatus).toEqual({ 200: 2, 404: 1 });
  });

  it("counts only 5xx as errors, and computes the error rate", () => {
    metrics.recordRequest(200, 1);
    metrics.recordRequest(404, 1); // client error, not counted
    metrics.recordRequest(500, 1);
    metrics.recordRequest(503, 1);
    const snap = metrics.snapshot();
    expect(snap.requests.errors).toBe(2);
    expect(snap.requests.errorRate).toBeCloseTo(2 / 4);
  });

  it("reports latency percentiles from recorded durations", () => {
    for (let i = 1; i <= 100; i++) metrics.recordRequest(200, i);
    const snap = metrics.snapshot();
    expect(snap.latencyMs.p50).toBeGreaterThanOrEqual(45);
    expect(snap.latencyMs.p50).toBeLessThanOrEqual(55);
    expect(snap.latencyMs.p99).toBeGreaterThanOrEqual(95);
    expect(snap.latencyMs.sampleSize).toBe(100);
  });

  it("reports memory usage and uptime as present, sane numbers", () => {
    const snap = metrics.snapshot();
    expect(snap.memory.rssMb).toBeGreaterThan(0);
    expect(snap.memory.heapUsedMb).toBeGreaterThan(0);
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("reset clears all counters", () => {
    metrics.recordRequest(500, 10);
    metrics.reset();
    const snap = metrics.snapshot();
    expect(snap.requests.total).toBe(0);
    expect(snap.requests.byStatus).toEqual({});
  });
});
