/**
 * Fleet-wide settings. Requires `manage_users`.
 *
 * Two of these need honesty rather than polish:
 *   - Health thresholds are a *fallback*. Anthropic reports its own severity
 *     per rate-limit window and that wins where present.
 *   - Retention does not run on a schedule. The API has no scheduler, so it
 *     only happens when someone presses Purge or an external cron calls it.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { AccountRow, AccountsResponse, RoleInfo } from "../api/types";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHead,
  CodeBlock,
  ConfirmDialog,
  Eyebrow,
  Field,
  Input,
  LoadingState,
  ErrorState,
  Select,
  useToast,
} from "../components/ui";

interface FleetSettings {
  registrationOpen: boolean;
  defaultRole: string;
  healthModeratePct: number;
  healthHeavyPct: number;
  retentionDays: number;
}

export function AdminSettings() {
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<FleetSettings | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);

  useEffect(() => {
    document.title = "Fleet settings — Meterhouse";
  }, []);

  const q = useQuery({
    queryKey: qk.settings,
    queryFn: () => api.get<{ settings: FleetSettings }>("/settings"),
  });
  useEffect(() => {
    if (q.data?.settings) setDraft(q.data.settings);
  }, [q.data]);

  const roles = useQuery({
    queryKey: qk.roles,
    queryFn: () => api.get<RoleInfo[]>("/admin/roles"),
  });

  // Shown read-only: which machines actually have reporting switched on. The
  // server cannot change these — they are local agent flags.
  const accounts = useQuery({
    queryKey: qk.accounts,
    queryFn: () => api.get<AccountsResponse>("/accounts"),
  });

  const save = useMutation({
    mutationFn: (next: FleetSettings) => api.patch("/settings", next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.settings });
      qc.invalidateQueries({ queryKey: qk.registrationOpen });
      toast.push("Settings saved.");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const purge = useMutation({
    mutationFn: () => api.post<{ purged: boolean; events?: number; reason?: string }>(
      "/settings/purge",
    ),
    onSuccess: (r) => {
      setConfirmPurge(false);
      qc.invalidateQueries({ queryKey: qk.summary });
      toast.push(r.purged ? `Removed ${r.events ?? 0} usage events.` : r.reason ?? "Nothing to do.");
    },
    onError: (e: Error) => {
      setConfirmPurge(false);
      toast.push(e.message, "error");
    },
  });

  if (q.isLoading || !draft) {
    return (
      <Card>
        <LoadingState />
      </Card>
    );
  }
  if (q.isError) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data?.settings);
  const reporting: AccountRow[] = accounts.data?.accounts ?? [];
  const reportingSystems = reporting.reduce((n, a) => n + a.systems.length, 0);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Admin</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Fleet settings</h1>
        <p className="mt-1.5 text-base text-muted">
          Settings that apply to everyone on this instance.
        </p>
      </div>

      <Card>
        <CardHead title="Access" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Self-service signup"
            hint="When closed, only people an admin has invited can sign in."
          >
            {(p) => (
              <Select
                {...p}
                value={draft.registrationOpen ? "open" : "closed"}
                onChange={(e) =>
                  setDraft({ ...draft, registrationOpen: e.target.value === "open" })
                }
              >
                <option value="open">Open — anyone can sign up</option>
                <option value="closed">Closed — invite only</option>
              </Select>
            )}
          </Field>
          <Field label="Role for new accounts" hint="Applied to people who sign themselves up.">
            {(p) => (
              <Select
                {...p}
                value={draft.defaultRole}
                onChange={(e) => setDraft({ ...draft, defaultRole: e.target.value })}
              >
                {(roles.data ?? []).map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Alert tone="info">
          Signup always works while no accounts exist, so the first administrator can always be
          created.
        </Alert>
      </Card>

      <Card>
        <CardHead
          title="Health thresholds"
          right={<Badge tone="neutral">Fallback only</Badge>}
        />
        <Alert tone="info">
          Anthropic reports its own severity for each rate-limit window, and that always wins.
          These percentages only decide the colour when no severity is available.
        </Alert>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Moderate above (%)" hint="Amber.">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={1}
                max={99}
                value={draft.healthModeratePct}
                onChange={(e) =>
                  setDraft({ ...draft, healthModeratePct: Number(e.target.value) })
                }
              />
            )}
          </Field>
          <Field label="Heavy above (%)" hint="Red.">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={2}
                max={100}
                value={draft.healthHeavyPct}
                onChange={(e) => setDraft({ ...draft, healthHeavyPct: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
        {draft.healthModeratePct >= draft.healthHeavyPct && (
          <Alert tone="warn">
            Moderate must be below heavy, or nothing would ever read as heavy. It will be adjusted
            when saved.
          </Alert>
        )}
      </Card>

      <Card>
        <CardHead title="Fleet privacy" hint={`${reportingSystems} PCs reporting accounts`} />
        <div className="text-base text-ink-2">
          Account reporting and session-title sync are per-machine switches. The Connect PC
          command turns account reporting on as part of setup; session-title sync stays off. The
          server cannot change either remotely — each machine opts in and out locally.
        </div>
        <div className="mt-3">
          <CodeBlock
            label="Run on each PC"
            code={[
              "meterhouse account show      # preview exactly what would be sent",
              "meterhouse account enable    # share account identity + rate limits",
              "meterhouse account disable   # opt back out",
              "",
              "# Session titles are a separate opt-in (titles describe work):",
              "METERHOUSE_SESSION_TITLES=true",
            ].join("\n")}
          />
        </div>
        {reportingSystems === 0 && (
          <Alert tone="info">
            No machines are reporting account data yet, so the Claude accounts page will be empty.
          </Alert>
        )}
      </Card>

      <Card>
        <CardHead title="Data retention" right={<Badge tone="neutral">Manual</Badge>} />
        <Alert tone="warn" title="Retention does not run automatically">
          There is no scheduler in this API. History is only removed when someone presses Purge
          below, or when an external cron calls <code>POST /api/v1/settings/purge</code>.
        </Alert>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field
            label="Keep usage history for (days)"
            hint="0 keeps everything. Purge deletes usage events and daily rollups older than this."
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                max={3650}
                value={draft.retentionDays}
                onChange={(e) => setDraft({ ...draft, retentionDays: Number(e.target.value) })}
              />
            )}
          </Field>
          <div className="flex items-end">
            <Button
              variant="danger"
              size="sm"
              disabled={draft.retentionDays <= 0 || dirty}
              onClick={() => setConfirmPurge(true)}
            >
              Purge now
            </Button>
          </div>
        </div>
        {dirty && draft.retentionDays > 0 && (
          <div className="mt-2 text-xs text-muted">Save your changes before purging.</div>
        )}
      </Card>

      <div className="flex justify-end gap-2">
        <Button
          variant="subtle"
          size="sm"
          disabled={!dirty}
          onClick={() => q.data && setDraft(q.data.settings)}
        >
          Discard changes
        </Button>
        <Button size="sm" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(draft)}>
          Save settings
        </Button>
      </div>

      <ConfirmDialog
        open={confirmPurge}
        title={`Delete usage older than ${draft.retentionDays} days?`}
        body="Usage events and daily rollups older than the retention window are permanently removed. This cannot be undone, and the data cannot be re-synced — agents only keep their own local copy."
        confirmLabel="Purge history"
        destructive
        busy={purge.isPending}
        onConfirm={() => purge.mutate()}
        onCancel={() => setConfirmPurge(false)}
      />
    </div>
  );
}
