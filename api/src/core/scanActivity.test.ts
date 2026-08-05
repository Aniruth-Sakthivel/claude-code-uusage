import { describe, expect, it } from "vitest";

import { deriveScanActivity, STATE_TRUSTED_FOR_MS } from "./scanActivity.js";

const now = new Date("2026-08-05T12:00:00Z");
const agoSeconds = (s: number) => new Date(now.getTime() - s * 1000);

const base = {
  agentStatus: "idle",
  agentStatusAt: agoSeconds(10),
  agentStatusDetail: "next scan in 60s",
  scanIntervalSeconds: 60,
  lastScanAt: agoSeconds(10),
  lastScanDurationMs: 240,
};

describe("deriveScanActivity", () => {
  it("reports a scan in progress", () => {
    const v = deriveScanActivity({ ...base, agentStatus: "scanning" }, now);
    expect(v.agent_state).toBe("scanning");
    expect(v.scanning).toBe(true);
  });

  it("counts a sync as still working", () => {
    expect(deriveScanActivity({ ...base, agentStatus: "syncing" }, now).scanning).toBe(true);
  });

  it("is not scanning once the cycle finished", () => {
    const v = deriveScanActivity(base, now);
    expect(v.agent_state).toBe("idle");
    expect(v.scanning).toBe(false);
  });

  /** The failure this guards: a killed agent stuck on "Scanning…" forever. */
  it("stops trusting a stale report", () => {
    const stale = {
      ...base,
      agentStatus: "scanning",
      agentStatusAt: new Date(now.getTime() - STATE_TRUSTED_FOR_MS - 1000),
    };
    const v = deriveScanActivity(stale, now);
    expect(v.agent_state).toBe("unknown");
    expect(v.scanning).toBe(false);
    expect(v.agent_state_detail).toBe("");
  });

  it("keeps the boundary itself trusted", () => {
    const edge = {
      ...base,
      agentStatus: "scanning",
      agentStatusAt: new Date(now.getTime() - STATE_TRUSTED_FOR_MS),
    };
    expect(deriveScanActivity(edge, now).agent_state).toBe("scanning");
  });

  it("derives the next scan from the last one plus the interval", () => {
    const v = deriveScanActivity({ ...base, lastScanAt: agoSeconds(20) }, now);
    expect(v.next_scan_due_at).toBe(new Date(now.getTime() + 40_000).toISOString());
  });

  it("offers no countdown without a reported interval", () => {
    const v = deriveScanActivity({ ...base, scanIntervalSeconds: null }, now);
    expect(v.next_scan_due_at).toBeNull();
    expect(v.scan_interval_seconds).toBeNull();
  });

  it("offers no countdown before the first scan", () => {
    expect(deriveScanActivity({ ...base, lastScanAt: null }, now).next_scan_due_at).toBeNull();
  });

  it("treats a machine that has never reported as unknown", () => {
    const v = deriveScanActivity(
      {
        agentStatus: "",
        agentStatusAt: null,
        agentStatusDetail: "",
        scanIntervalSeconds: null,
        lastScanAt: null,
        lastScanDurationMs: null,
      },
      now,
    );
    expect(v.agent_state).toBe("unknown");
    expect(v.scanning).toBe(false);
  });

  /** An unrecognised state from a newer agent must not render as a live scan. */
  it("treats an unknown state string as unknown", () => {
    expect(deriveScanActivity({ ...base, agentStatus: "hibernating" }, now).agent_state).toBe(
      "unknown",
    );
  });

  it("stamps the server clock so clients can correct for skew", () => {
    expect(deriveScanActivity(base, now).server_time).toBe(now.toISOString());
  });
});
