/**
 * Dashboard WebSocket client.
 *
 * Mirrors the server contract in api/src/ws/protocol.ts. Native WebSocket
 * can't set headers, so auth travels as a `?token=` query param (the server
 * side of this is api/src/ws/server.ts's /dashboard path) — the socket is
 * closed with code 4401 if the token is missing/invalid/expired, which this
 * client treats as "get a fresh token and reconnect," not a fatal error.
 *
 * Entirely optional infrastructure: with VITE_PUBLIC_WS_URL unset, connect()
 * is a no-op and callers relying on onSystemUpdated/onAlert just never fire —
 * existing polling/timeout fallbacks keep working unchanged.
 */

import { supabase } from "./supabase";

export interface SystemUpdatedEvent {
  type: "system_updated";
  system_id: string;
  reason: "scan_result" | "heartbeat" | "alert";
  at: string;
}

export interface AlertEvent {
  type: "alert";
  system_id: string;
  level: "info" | "warning" | "error";
  message: string;
  at: string;
}

type Listener<T> = (event: T) => void;

const MAX_BACKOFF_MS = 30_000;

class DashboardSocket {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly systemListeners = new Set<Listener<SystemUpdatedEvent>>();
  private readonly alertListeners = new Set<Listener<AlertEvent>>();

  connect(): void {
    if (!import.meta.env.VITE_PUBLIC_WS_URL) return; // WS infra not configured — no-op.
    this.closedByUs = false;
    void this.open();
  }

  disconnect(): void {
    this.closedByUs = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  onSystemUpdated(cb: Listener<SystemUpdatedEvent>): () => void {
    this.systemListeners.add(cb);
    return () => this.systemListeners.delete(cb);
  }

  onAlert(cb: Listener<AlertEvent>): () => void {
    this.alertListeners.add(cb);
    return () => this.alertListeners.delete(cb);
  }

  private async open(): Promise<void> {
    const base = import.meta.env.VITE_PUBLIC_WS_URL as string;
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) return; // Not signed in — nothing to authenticate the socket with.

    const url = `${base.replace(/\/$/, "")}/dashboard?token=${encodeURIComponent(session.access_token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string);
        if (msg?.type === "system_updated") {
          for (const cb of this.systemListeners) cb(msg as SystemUpdatedEvent);
        } else if (msg?.type === "alert") {
          for (const cb of this.alertListeners) cb(msg as AlertEvent);
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    ws.onclose = () => {
      if (this.closedByUs) return;
      this.attempt += 1;
      const delay = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
      this.reconnectTimer = setTimeout(() => void this.open(), delay);
    };

    ws.onerror = () => ws.close();
  }
}

export const dashboardSocket = new DashboardSocket();
