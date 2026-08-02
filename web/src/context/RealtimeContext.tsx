/**
 * Opens one dashboard WebSocket per authenticated session and re-exposes its
 * pub-sub as a hook, so any page can subscribe to live system_updated/alert
 * events without knowing about connection lifecycle. See lib/ws.ts for the
 * transport; this just ties it to sign-in/sign-out.
 */

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { SystemRow } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { useToast } from "../components/ui";
import {
  dashboardSocket,
  type AlertEvent,
  type BoardDeleteEvent,
  type BoardOp,
  type BoardUpdateEvent,
  type ChatMessageEvent,
  type SystemUpdatedEvent,
} from "../lib/ws";

interface RealtimeState {
  onSystemUpdated: (cb: (event: SystemUpdatedEvent) => void) => () => void;
  onAlert: (cb: (event: AlertEvent) => void) => () => void;
  onChatMessage: (cb: (event: ChatMessageEvent) => void) => () => void;
  sendChat: (channelId: number, body: string) => boolean;
  onBoardUpdate: (cb: (event: BoardUpdateEvent) => void) => () => void;
  onBoardDelete: (cb: (event: BoardDeleteEvent) => void) => () => void;
  sendBoardOp: (boardId: number, op: BoardOp) => boolean;
}

const Ctx = createContext<RealtimeState | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;
    dashboardSocket.connect();
    return () => dashboardSocket.disconnect();
  }, [user]);

  const value: RealtimeState = {
    onSystemUpdated: (cb) => dashboardSocket.onSystemUpdated(cb),
    onAlert: (cb) => dashboardSocket.onAlert(cb),
    onChatMessage: (cb) => dashboardSocket.onChatMessage(cb),
    sendChat: (channelId, body) => dashboardSocket.sendChat(channelId, body),
    onBoardUpdate: (cb) => dashboardSocket.onBoardUpdate(cb),
    onBoardDelete: (cb) => dashboardSocket.onBoardDelete(cb),
    sendBoardOp: (boardId, op) => dashboardSocket.sendBoardOp(boardId, op),
  };

  return (
    <Ctx.Provider value={value}>
      <ConnectNotifier />
      {children}
    </Ctx.Provider>
  );
}

/**
 * Live "a new PC connected" toast for admins/managers/viewers — anyone who
 * can see the whole fleet (visibleSystemIds is unrestricted for these roles).
 * There's no dedicated server-side "system connected" event (connectPc runs
 * in the Netlify Functions process, a different process from the WS server,
 * so it can't broadcast directly) — instead this piggybacks on the agent's
 * first scan_result/sync broadcast, which already fires within seconds of
 * install finishing, and treats "system_id not seen before" as "new."
 */
function ConnectNotifier() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const knownIds = useRef<Set<string> | null>(null);

  const canSeeFleet = !!user?.capabilities?.includes("view_all");

  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
    enabled: canSeeFleet,
  });

  useEffect(() => {
    if (systems.data && !knownIds.current) {
      knownIds.current = new Set(systems.data.map((s) => s.system_id));
    }
  }, [systems.data]);

  useEffect(() => {
    if (!canSeeFleet) return;
    return dashboardSocket.onSystemUpdated((evt) => {
      const known = knownIds.current;
      if (!known || known.has(evt.system_id)) return;
      known.add(evt.system_id);
      qc.invalidateQueries({ queryKey: qk.systems }).then(() => {
        const name =
          qc
            .getQueryData<SystemRow[]>(qk.systems)
            ?.find((s) => s.system_id === evt.system_id)?.display_name ?? "A PC";
        toast.push(`${name} connected to the fleet.`, "success");
      });
    });
  }, [canSeeFleet, qc, toast]);

  return null;
}

export function useRealtime() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRealtime must be used within RealtimeProvider");
  return ctx;
}
