/**
 * Your account settings.
 *
 * Everything here is scoped to the signed-in person. Fleet-wide controls live
 * on the admin settings page, which needs `manage_users`.
 *
 * The "My PCs" section is read-only on purpose: the agent's privacy switches
 * live on each machine, not on the server, so the page shows the command to
 * run rather than pretending it can flip them remotely.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { SystemRow } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { supabase } from "../lib/supabase";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHead,
  CodeBlock,
  Eyebrow,
  Field,
  FormCard,
  Input,
  LoadingState,
  StatusPill,
  useToast,
} from "../components/ui";
import { ThemeToggle } from "../lib/theme";
import { fmtRelative } from "../lib/format";

/**
 * Notification toggles.
 *
 * These are stored but nothing reads them yet — there is no alerting
 * subsystem. The card says so, so nobody switches one on and waits for an
 * email that will never arrive.
 */
const NOTIFICATIONS: { key: string; label: string; hint: string }[] = [
  {
    key: "account_heavy_usage",
    label: "Heavy account usage",
    hint: "When a Claude account you use passes its heavy-usage threshold.",
  },
  {
    key: "agent_offline",
    label: "Agent offline",
    hint: "When one of your PCs stops reporting.",
  },
  {
    key: "account_switched",
    label: "Account switched",
    hint: "When one of your PCs signs into a different Claude account.",
  },
  {
    key: "weekly_summary",
    label: "Weekly summary",
    hint: "A digest of your usage each week.",
  },
];

export function Settings() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  useEffect(() => {
    document.title = "Settings — Meterhouse";
  }, []);

  // ── profile ──────────────────────────────────────────────────────────────
  const [fullName, setFullName] = useState(user?.full_name ?? "");
  useEffect(() => setFullName(user?.full_name ?? ""), [user?.full_name]);

  const saveProfile = useMutation({
    mutationFn: (name: string) => api.patch("/me/profile", { full_name: name }),
    onSuccess: async () => {
      await refresh();
      toast.push("Profile saved.");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  // ── password ─────────────────────────────────────────────────────────────
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    if (password.length < 8) {
      setPwError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setPwError("The two passwords do not match.");
      return;
    }
    setPwBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setPwBusy(false);
    if (error) {
      setPwError(error.message);
      return;
    }
    setPassword("");
    setConfirm("");
    toast.push("Password changed.");
  }

  // ── my PCs ───────────────────────────────────────────────────────────────
  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
  });
  const mine = (systems.data ?? []).filter((s) => user?.system_ids?.includes(s.system_id));

  // ── notifications ────────────────────────────────────────────────────────
  const prefs = useQuery({
    queryKey: qk.preferences,
    queryFn: () => api.get<{ notifications: Record<string, boolean> }>("/me/preferences"),
  });

  const savePrefs = useMutation({
    mutationFn: (next: Record<string, boolean>) => api.patch("/me/preferences", next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.preferences });
      toast.push("Preferences saved.");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const current = prefs.data?.notifications ?? {};

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Your account</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1.5 text-base text-muted">
          Your profile, appearance, machines, and notifications.
        </p>
      </div>

      <FormCard
        onSubmit={(e) => {
          e.preventDefault();
          saveProfile.mutate(fullName);
        }}
      >
        <CardHead title="Profile" hint={user?.role} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Display name" required>
            {(p) => (
              <Input
                {...p}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                maxLength={120}
                required
              />
            )}
          </Field>
          <Field label="Email" hint="Managed by your login provider — not editable here.">
            {(p) => <Input {...p} value={user?.email ?? ""} disabled />}
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            type="submit"
            size="sm"
            loading={saveProfile.isPending}
            disabled={!fullName.trim() || fullName === user?.full_name}
          >
            Save profile
          </Button>
        </div>
      </FormCard>

      <Card>
        <CardHead title="Appearance" hint="Saved on this device" />
        <div className="flex items-center justify-between gap-4">
          <div className="text-base text-ink-2">
            Switch between the light and dark theme.
          </div>
          <ThemeToggle />
        </div>
      </Card>

      <Card>
        <CardHead title="My PCs" hint={`${mine.length} assigned`} />
        {systems.isLoading ? (
          <LoadingState />
        ) : mine.length === 0 ? (
          <div className="text-base text-muted">
            No machines are assigned to you yet.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {mine.map((s) => (
              <div
                key={s.system_id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-ink">{s.display_name}</div>
                  <div className="text-xs text-muted">
                    {s.hostname || "—"} · last sync{" "}
                    <span className="tnum">
                      {s.never_synced ? "never" : fmtRelative(s.last_sync_at)}
                    </span>
                  </div>
                </div>
                <StatusPill status={s.status} neverSynced={s.never_synced} health={s.health} reason={s.reason} />
              </div>
            ))}
          </div>
        )}

        <div className="mt-4">
          <Alert tone="info" title="Privacy switches live on the machine">
            Claude account reporting turns on automatically when a PC is connected via the
            "Connect a PC" page; session-title sync stays off. Both can only be changed on the PC
            itself — the server cannot turn them on remotely. Run these on the machine to see
            exactly what is being sent, then decide:
          </Alert>
          <div className="mt-3">
            <CodeBlock
              label="On the PC"
              code={[
                "meterhouse account show      # preview the payload - sends nothing",
                "meterhouse account enable    # share account + plan + rate limits",
                "",
                "# Session titles are a separate opt-in:",
                "METERHOUSE_SESSION_TITLES=true meterhouse sync",
              ].join("\n")}
            />
          </div>
        </div>
      </Card>

      <FormCard onSubmit={changePassword}>
        <CardHead title="Change password" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New password" hint="At least 8 characters." required>
            {(p) => (
              <Input
                {...p}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            )}
          </Field>
          <Field label="Confirm new password" error={pwError ?? undefined} required>
            {(p) => (
              <Input
                {...p}
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            )}
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button type="submit" size="sm" loading={pwBusy} disabled={!password || !confirm}>
            Change password
          </Button>
        </div>
      </FormCard>

      <Card>
        <CardHead
          title="Notifications"
          right={<Badge tone="neutral">Not yet delivered</Badge>}
        />
        <Alert tone="warn" title="These preferences are saved but not acted on">
          Meterhouse has no alerting system yet, so nothing is sent for any of these. Your choices
          are stored and will apply once delivery is built.
        </Alert>

        {prefs.isLoading ? (
          <LoadingState />
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {NOTIFICATIONS.map((n) => (
              <label
                key={n.key}
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 transition hover:border-accent/40"
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-[var(--accent)]"
                  checked={Boolean(current[n.key])}
                  onChange={(e) =>
                    savePrefs.mutate({ ...current, [n.key]: e.target.checked })
                  }
                />
                <span className="min-w-0">
                  <span className="block font-semibold text-ink">{n.label}</span>
                  <span className="block text-xs text-muted">{n.hint}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
