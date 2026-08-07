/**
 * Tracks whether a just-connected PC has actually reported in yet.
 *
 * Shared by every page that renders `ConnectPanel` (Connect, and the
 * first-run Welcome screen) so "waiting for it to check in" behaves
 * identically everywhere instead of only on the page that happened to get it
 * built first. See `ConnectPanel`'s `ConnectWaitStatusBlock` for how this is
 * rendered.
 *
 * Detection has exactly one decision path — `systems.data` changing — reached
 * two ways: a fast poll while something is actively awaited (the ground
 * truth, independent of the WebSocket), and the WebSocket's system_updated
 * push, which only pulls that data in sooner. Because both roads lead to the
 * same effect, polling and the live socket can never disagree about what
 * "connected" means.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { ConnectWaitStatus } from "../components/ConnectPanel";
import { useToast } from "../components/ui";
import type { SystemRow } from "../api/types";
import { useRealtime } from "../context/RealtimeContext";

/** Stop waiting and say so after this long, rather than leaving a page
 * looking like it's still working forever with nothing to show for it. */
const AWAIT_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

/** Only used while something is actively being waited on — no page needs a
 * 4s refresh at rest, and this must not keep polling after a tab is left
 * open long past a successful (or abandoned) connect. */
const POLL_INTERVAL_MS = 4_000;

type ConnectWait =
  | { status: "idle" }
  | { status: "connecting"; systemId: string }
  | { status: "connected"; systemId: string }
  | { status: "timeout"; systemId: string };

export function useConnectWait() {
  const toast = useToast();
  const qc = useQueryClient();
  const realtime = useRealtime();
  const [wait, setWait] = useState<ConnectWait>({ status: "idle" });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
    refetchInterval: wait.status === "connecting" ? POLL_INTERVAL_MS : false,
  });

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  function armTimeout(systemId: string) {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      // Only fires the wait actually being tracked — a stale timer from a PC
      // that already connected, or that the caller moved on from, must not
      // overwrite whatever is showing now.
      setWait((prev) =>
        prev.status === "connecting" && prev.systemId === systemId
          ? { status: "timeout", systemId }
          : prev,
      );
    }, AWAIT_SYNC_TIMEOUT_MS);
  }

  useEffect(() => {
    if (wait.status !== "connecting") return;
    const target = systems.data?.find((s) => s.system_id === wait.systemId);
    if (!target || target.never_synced) return;
    clearTimeout(timeoutRef.current);
    setWait({ status: "connected", systemId: wait.systemId });
    toast.push(`${target.display_name} connected and synced successfully.`, "success");
  }, [systems.data, wait, toast]);

  useEffect(() => {
    return realtime.onSystemUpdated((evt) => {
      if (wait.status === "connecting" && evt.system_id === wait.systemId) {
        qc.invalidateQueries({ queryKey: qk.systems });
      }
    });
  }, [wait, realtime, qc]);

  const connectStatus: ConnectWaitStatus | undefined =
    wait.status === "idle" ? undefined : wait.status;

  return {
    systems,
    connectStatus,
    onConnected: (systemId: string) => {
      setWait({ status: "connecting", systemId });
      armTimeout(systemId);
    },
    onRetryWait: () => {
      if (wait.status !== "timeout") return;
      setWait({ status: "connecting", systemId: wait.systemId });
      armTimeout(wait.systemId);
      systems.refetch();
    },
  };
}
