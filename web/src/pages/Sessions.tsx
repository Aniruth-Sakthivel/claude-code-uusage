/**
 * Recent Claude Code sessions. Metadata only — session ids, models, timestamps
 * and token counts. Never prompts, responses, or code.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { SessionRow, SystemRow } from "../api/types";
import {
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  LoadingState,
  Table,
  Td,
  Th,
} from "../components/ui";
import { fmtRelative, fmtTokens } from "../lib/format";

export function Sessions() {
  const sessions = useQuery({
    queryKey: qk.sessions,
    queryFn: () => api.get<SessionRow[]>("/sessions"),
  });
  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
  });

  useEffect(() => {
    document.title = "Sessions — ClaudeFleet";
  }, []);

  const nameOf = new Map((systems.data ?? []).map((s) => [s.system_id, s.display_name]));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Analytics</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="mt-1.5 text-base text-muted">
          Most recent Claude Code sessions. Metadata only — no conversation content is
          ever collected.
        </p>
      </div>

      <Card>
        {sessions.isLoading ? (
          <LoadingState />
        ) : sessions.isError ? (
          <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />
        ) : sessions.data!.length === 0 ? (
          <EmptyState
            title="No sessions yet"
            hint="Sessions appear after a connected PC syncs."
          />
        ) : (
          <Table caption="Recent sessions with model and token usage">
            <thead>
              <tr>
                <Th>Project</Th>
                <Th>PC</Th>
                <Th>Model</Th>
                <Th>Last active</Th>
                <Th align="right">In</Th>
                <Th align="right">Out</Th>
                <Th align="right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {sessions.data!.map((s) => (
                <tr key={`${s.system_id}:${s.session_id}`}>
                  <Td className="font-medium">{s.project_name}</Td>
                  <Td className="text-ink-2">
                    {nameOf.get(s.system_id) ?? s.system_id.slice(0, 8)}
                  </Td>
                  <Td className="text-ink-2">{s.model || "—"}</Td>
                  <Td className="tnum text-ink-2">{fmtRelative(s.last_ts)}</Td>
                  <Td align="right" className="tnum text-ink-2">
                    {fmtTokens(s.input_tokens)}
                  </Td>
                  <Td align="right" className="tnum text-ink-2">
                    {fmtTokens(s.output_tokens)}
                  </Td>
                  <Td align="right" className="tnum font-semibold">
                    {fmtTokens(s.total_tokens)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
