/**
 * The single "connect a PC" experience.
 *
 * Replaces three separate implementations (the Login setup card, the Connect
 * page, and the Admin Keys enroll card) that each created systems differently
 * and left users unsure which one was correct.
 *
 * Available to every role: the backend's `/connect/self` endpoint is not
 * admin-gated, which is what previously stranded developers and viewers on an
 * empty dashboard with no way to add their own machine.
 *
 * Note on scope: a browser cannot read `~/.claude/projects/*.jsonl` — sandboxing
 * forbids it — so no button here can scan a PC directly. What this does deliver
 * is one command, after which the agent scans and syncs every 15 minutes on its
 * own.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { api } from "../api/client";
import { fleetKeys } from "../api/queryKeys";
import type { ConnectResponse, SystemRow } from "../api/types";
import {
  AGENT_INSTALL,
  BACKGROUND_TASK_COMMAND,
  SCAN_COMMAND,
  SYNC_COMMAND,
  accountReportCommands,
  registerCommand,
  serverUrl,
} from "../lib/agentSetup";
import {
  Alert,
  Button,
  Card,
  CardHead,
  CodeBlock,
  Field,
  FormCard,
  Input,
  Select,
  useToast,
} from "./ui";

const ENVIRONMENTS = ["", "development", "staging", "production", "personal"];

/**
 * One command, one step.
 *
 * The setup used to be a single ~30-line block with one copy button. Everything
 * in it — the install, the key, the optional extras, the uninstall notes — was
 * weighted the same, so people pasted the lot into the wrong shell or lost
 * their place halfway through. Splitting it lets each line be copied and run on
 * its own, and lets the required path be visually louder than the optional one.
 *
 * The numbering is not decoration: this is a real sequence, and a step run out
 * of order fails.
 */
function Step({
  n,
  title,
  children,
  code,
  optional = false,
}: {
  n: number;
  title: string;
  children?: ReactNode;
  code?: string;
  optional?: boolean;
}) {
  return (
    <li className="flex gap-3 sm:gap-4">
      <div
        className={[
          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums",
          optional
            ? "border border-dashed border-line text-muted"
            : "bg-accent text-white",
        ].join(" ")}
        aria-hidden
      >
        {n}
      </div>

      <div className="min-w-0 flex-1 pb-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-base font-medium">{title}</span>
          {optional && (
            <span className="rounded-full border border-line px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Optional
            </span>
          )}
        </div>
        {children && <div className="mb-2 text-sm text-muted">{children}</div>}
        {code && <CodeBlock code={code} shell />}
      </div>
    </li>
  );
}

function defaultName(): string {
  // A sensible starting point the user can edit.
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "My Windows PC";
  if (/Macintosh|Mac OS/i.test(ua)) return "My Mac";
  if (/Linux/i.test(ua)) return "My Linux PC";
  return "My PC";
}

export function ConnectPanel({
  systems = [],
  onConnected,
}: {
  systems?: SystemRow[];
  onConnected?: (systemId: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();

  const [displayName, setDisplayName] = useState(defaultName());
  const [environment, setEnvironment] = useState("");
  const [reuseId, setReuseId] = useState<string>("");
  const [result, setResult] = useState<ConnectResponse | null>(null);

  const connect = useMutation({
    mutationFn: () =>
      api.post<ConnectResponse>("/connect/self", {
        display_name: displayName.trim(),
        system_id: reuseId || null,
        environment,
      }),
    onSuccess: (data) => {
      setResult(data);
      for (const key of fleetKeys) qc.invalidateQueries({ queryKey: key });
      onConnected?.(data.system_id);
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  // The API key is shown once and never persisted anywhere retrievable —
  // warn before an accidental tab close/navigation loses it.
  useEffect(() => {
    if (!result) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [result]);

  if (result) {
    return (
      <Card>
        <CardHead
          title={`Connect “${result.display_name}”`}
          right={
            <Button
              variant="subtle"
              size="sm"
              onClick={() => {
                setResult(null);
                connect.reset();
              }}
            >
              Connect another PC
            </Button>
          }
        />

        <Alert tone="warn" title="Use PowerShell, not cmd.exe">
          Press <kbd className="rounded border border-line px-1">Win</kbd> +{" "}
          <kbd className="rounded border border-line px-1">X</kbd> and choose Terminal or
          PowerShell on the PC you want to track. cmd.exe does not strip the quotes in
          step 3, so they end up inside your key and the connection fails. Needs{" "}
          <a
            href="https://python.org/downloads"
            className="font-semibold text-accent underline underline-offset-2"
          >
            Python 3.10+
          </a>
          .
        </Alert>

        <ol className="mt-4 flex flex-col gap-5">
          <Step n={1} title="Install the agent" code={AGENT_INSTALL}>
            Run once per PC. Commands use{" "}
            <code className="rounded bg-surface-2 px-1">python -m</code> because pip puts
            the <code className="rounded bg-surface-2 px-1">meterhouse</code> shortcut in a
            folder Windows leaves off PATH.
          </Step>

          <Step
            n={2}
            title="Connect this PC"
            code={registerCommand(serverUrl(), result.api_key, result.display_name)}
          >
            Your API key is in this line and does not expire — keep it somewhere safe.
          </Step>

          <Step n={3} title="Read local usage" code={SCAN_COMMAND}>
            Reads token counts from <code className="rounded bg-surface-2 px-1">~/.claude</code>{" "}
            into a local database. Prompts, responses, and source code are never read.
          </Step>

          <Step n={4} title="Send it to the dashboard" code={SYNC_COMMAND}>
            This is the one that makes data appear. Refresh the dashboard after it prints{" "}
            <code className="rounded bg-surface-2 px-1">Sync complete</code>.
          </Step>

          <Step n={5} title="Keep it syncing by itself" code={BACKGROUND_TASK_COMMAND}>
            Scans and syncs every 15 minutes in the background — no window to leave open,
            survives logout and reboot. (<code className="rounded bg-surface-2 px-1">
              meterhouse daemon
            </code>{" "}
            is the foreground alternative and stops when you close the terminal.)
          </Step>

          <Step n={6} title="Report Claude account usage" optional code={accountReportCommands()}>
            Adds this machine to the Claude accounts page with plan and rate-limit usage.{" "}
            <code className="rounded bg-surface-2 px-1">show</code> prints exactly what
            would be sent without sending it; the sync transmits it.
          </Step>
        </ol>

        <details className="mt-5 rounded-xl border border-line bg-surface-2 p-3">
          <summary className="cursor-pointer text-sm font-semibold">
            Copy everything as one block, or just the key
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <CodeBlock code={result.api_key} label="API key" />
            <CodeBlock code={result.manual_commands} label="Full setup, including uninstall" shell />
          </div>
        </details>
      </Card>
    );
  }

  return (
    <FormCard
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (displayName.trim()) connect.mutate();
      }}
    >
      <CardHead
        title="Connect this PC"
        hint="One command. Then it updates itself."
      />

      <Field label="What should we call this PC?" required>
        {(p) => (
          <Input
            {...p}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Design Laptop"
            maxLength={120}
            required
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Environment" hint="Optional label for grouping.">
          {(p) => (
            <Select
              {...p}
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            >
              {ENVIRONMENTS.map((v) => (
                <option key={v} value={v}>
                  {v || "— none —"}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {systems.length > 0 && (
          <Field
            label="Reconnecting an existing PC?"
            hint="Issues a fresh key for a machine already listed."
          >
            {(p) => (
              <Select {...p} value={reuseId} onChange={(e) => setReuseId(e.target.value)}>
                <option value="">No — this is a new PC</option>
                {systems.map((s) => (
                  <option key={s.system_id} value={s.system_id}>
                    {s.display_name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>

      <div>
        <Button type="submit" loading={connect.isPending} disabled={!displayName.trim()}>
          Generate setup command
        </Button>
      </div>

      <p className="text-sm text-muted">
        Only token counts and file metadata are ever sent — never your prompts, responses,
        or source code.
      </p>
    </FormCard>
  );
}
