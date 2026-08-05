/**
 * Live scan activity for one machine.
 *
 * Answers the question an admin actually has in front of the Systems table —
 * "is this agent working?" — which "last sync 12m ago" cannot: that reads the
 * same whether the agent is mid-scan, idle between scans, or dead since
 * yesterday. Here a scan in progress says so while it runs, a finished cycle
 * says when it finished, and the countdown shows when the next one is due.
 *
 * The countdown ticks locally against the server's clock (the `server_time`
 * sent with each row), so a browser whose clock is minutes off does not
 * display a countdown minutes wrong.
 */

import { useEffect, useState } from "react";

import type { AgentState, ScanActivity as ScanActivityData } from "../api/types";
import { Badge } from "./ui";

const LABEL: Record<AgentState, string> = {
  scanning: "Scanning…",
  syncing: "Syncing…",
  scanned: "Scan complete",
  idle: "Completed",
  paused: "Paused",
  error: "Error",
  unknown: "No report",
};

const TONE: Record<AgentState, "neutral" | "accent" | "good" | "critical"> = {
  scanning: "accent",
  syncing: "accent",
  scanned: "good",
  idle: "good",
  paused: "neutral",
  error: "critical",
  unknown: "neutral",
};

/** "60s", "5m", "1h 15m" — an interval, not a timestamp. */
function fmtInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hrs}h ${rest}m` : `${hrs}h`;
}

/** mm:ss, counting down. */
function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/** One tick a second, so a countdown moves between the table's own polls. */
function useSecondTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
}

/** Everything the two renderers agree on, derived once. */
function useScanView(scan: ScanActivityData) {
  useSecondTick();

  const state: AgentState = scan.agent_state ?? "unknown";
  // The response's own clock, advanced locally — never the browser's clock.
  const skewMs = scan.server_time ? Date.now() - new Date(scan.server_time).getTime() : 0;
  const now = Date.now() - skewMs;

  const dueAt = scan.next_scan_due_at ? new Date(scan.next_scan_due_at).getTime() : null;
  const remaining = dueAt === null ? null : dueAt - now;

  return { state, active: scan.scanning, interval: scan.scan_interval_seconds, remaining };
}

export function ScanActivity({
  scan,
  neverReported = false,
}: {
  scan: ScanActivityData;
  /** Distinguishes "not set up yet" from "was working, has gone quiet". */
  neverReported?: boolean;
}) {
  const { state, active, interval, remaining } = useScanView(scan);

  let detail: string;
  if (active) {
    detail = scan.agent_state_detail || "in progress";
  } else if (state === "unknown") {
    // Nothing recent to trust — say so plainly instead of implying it is idle.
    detail = neverReported ? "has never reported" : "not reporting right now";
  } else if (remaining !== null && remaining > 0) {
    detail = `next scan in ${fmtCountdown(remaining)}`;
  } else if (remaining !== null) {
    detail = "next scan due";
  } else {
    detail = scan.agent_state_detail || "—";
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {active && (
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
            aria-hidden
          />
        )}
        <Badge tone={TONE[state]}>{LABEL[state]}</Badge>
      </div>
      <div className="tnum text-xs text-muted">
        {interval ? `every ${fmtInterval(interval)} · ` : ""}
        {detail}
      </div>
      {scan.last_scan_duration_ms !== null && state !== "unknown" && (
        <div className="tnum text-xs text-muted">
          last scan took {Math.round(scan.last_scan_duration_ms)} ms
        </div>
      )}
    </div>
  );
}

/**
 * One-line variant for dense lists — the timer shown beside a person's name.
 * Same data, no badge stack: at that size a pulsing dot plus "0:42" reads
 * faster than a labelled block.
 */
export function ScanTimer({ scan }: { scan: ScanActivityData }) {
  const { state, active, interval, remaining } = useScanView(scan);
  if (state === "unknown" && !interval) return null;

  const text = active
    ? LABEL[state]
    : remaining !== null && remaining > 0
      ? `scan in ${fmtCountdown(remaining)}`
      : interval
        ? `every ${fmtInterval(interval)}`
        : LABEL[state];

  return (
    <span
      className={`tnum inline-flex items-center gap-1 ${active ? "text-accent" : "text-muted"}`}
      title={
        interval
          ? `Agent scans every ${fmtInterval(interval)}${
              scan.agent_state_detail ? ` · ${scan.agent_state_detail}` : ""
            }`
          : scan.agent_state_detail
      }
    >
      {active && (
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
      )}
      {text}
    </span>
  );
}
