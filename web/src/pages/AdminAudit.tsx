/**
 * Audit log. Records who did what, and never contains secrets, prompts,
 * responses, or source code.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { AuditRow } from "../api/types";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  LoadingState,
  Table,
  Td,
  Th,
} from "../components/ui";
import { fmtRelative } from "../lib/format";

/** Destructive or security-relevant actions stand out. */
function toneFor(action: string): "neutral" | "accent" | "critical" {
  if (/revoked|deleted/.test(action)) return "critical";
  if (/created|invited|rotated|connected/.test(action)) return "accent";
  return "neutral";
}

export function AdminAudit() {
  const q = useQuery({ queryKey: qk.audit, queryFn: () => api.get<AuditRow[]>("/admin/audit") });

  useEffect(() => {
    document.title = "Audit log — ClaudeFleet";
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Admin</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1.5 text-base text-muted">
          Account, system, and key activity. Never contains secrets or conversation
          content.
        </p>
      </div>

      <Card>
        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data!.length === 0 ? (
          <EmptyState title="No activity recorded yet" />
        ) : (
          <Table caption="Recent administrative activity">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th>Target</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {q.data!.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap text-ink-2">{fmtRelative(a.at)}</Td>
                  <Td>
                    <Badge tone={toneFor(a.action)}>{a.action}</Badge>
                  </Td>
                  <Td className="text-ink-2">{a.actor_email}</Td>
                  <Td className="text-ink-2">{a.target || "—"}</Td>
                  <Td className="text-muted">{a.detail || "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
