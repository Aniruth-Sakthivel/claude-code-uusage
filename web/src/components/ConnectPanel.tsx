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
 * is one line to paste, after which the agent runs continuously in the
 * background on its own, independent of Claude Code sessions.
 *
 * That one line is the whole point of this screen. The server already generates
 * it (`install_command`), but this panel used to render only a seven-step
 * manual sequence and never showed it — so every user did by hand what a single
 * paste would have done, and the steps themselves described a scheduled task
 * the agent no longer installs. The manual path is still here, corrected, but
 * it is now the fallback it was always meant to be.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { api } from "../api/client";
import { fleetKeys } from "../api/queryKeys";
import type { ConnectResponse, SystemRow } from "../api/types";
import {
  AGENT_INSTALL,
  DAEMON_COMMAND,
  STATUS_COMMAND,
  accountReportCommands,
  connectCommand,
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
  Spinner,
  useToast,
} from "./ui";

const ENVIRONMENTS = ["", "development", "staging", "production", "personal"];

export type ConnectWaitStatus = "connecting" | "connected" | "timeout";

/**
 * The state a user actually needs while the command they just pasted is
 * still doing its work — a spinner while waiting, and an honest failure
 * state instead of silence if it never reports in. Rendered right under the
 * command itself, not in a banner elsewhere on the page, so someone watching
 * this card for a result is not left guessing whether anything is happening.
 */
function ConnectWaitStatusBlock({
  status,
  onRetry,
}: {
  status: ConnectWaitStatus;
  onRetry?: () => void;
}) {
  if (status === "connecting") {
    return (
      <div
        className="mt-4 flex items-start gap-3 rounded-xl border border-line bg-surface-2 p-3.5 text-sm"
        aria-live="polite"
      >
        <Spinner />
        <div>
          <div className="font-medium">Waiting for this PC to check in…</div>
          <div className="mt-0.5 text-muted">
            Keep this page open — it updates on its own. Usually under a minute; longer
            on a slow connection or a fresh Python install.
          </div>
        </div>
      </div>
    );
  }

  if (status === "connected") {
    return (
      <Alert tone="success" title="Connected">
        Reporting usage now. You're done — no need to keep this page open.
      </Alert>
    );
  }

  return (
    <Alert tone="warn" title="Still hasn't reported in">
      <p>
        Check the PowerShell window on that PC for an error, or run{" "}
        <code className="rounded bg-surface-2 px-1">{STATUS_COMMAND}</code> there — it
        says exactly what happened. This page keeps waiting either way.
      </p>
      {onRetry && (
        <Button size="sm" variant="subtle" className="mt-2.5" onClick={onRetry}>
          Check again
        </Button>
      )}
    </Alert>
  );
}

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
  connectStatus,
  onRetryWait,
}: {
  systems?: SystemRow[];
  onConnected?: (systemId: string) => void;
  /** Set by the caller once it starts waiting for this PC's first sync;
   * undefined renders nothing extra, so pages that don't track this (e.g.
   * the first-run Welcome screen) are unaffected. */
  connectStatus?: ConnectWaitStatus;
  /** Only used in the "timeout" state, to re-arm the wait. */
  onRetryWait?: () => void;
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
    // Shown as a wall-clock time rather than a countdown: the user is about to
    // walk to another machine, and "expires at 14:32" survives that trip in a
    // way that "expires in 15 minutes" does not.
    const expiresAt = new Date(result.expires_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    return (
      <Card>
        <CardHead
          title={`Connect “${result.display_name}”`}
          right={
            <Button
              variant="subtle"
              size="sm"
              onClick={() => {
                // A confirm only while still waiting — the one moment closing
                // this card actually loses something (the visible wait state;
                // the connection attempt on the PC itself is unaffected).
                if (
                  connectStatus === "connecting" &&
                  !window.confirm(
                    "Still waiting for this PC to check in. Connect another PC anyway?",
                  )
                ) {
                  return;
                }
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
          PowerShell on the PC you want to track. cmd.exe does not strip the quotes, so
          they end up inside your key and the connection fails. Needs{" "}
          <a
            href="https://python.org/downloads"
            className="font-semibold text-accent underline underline-offset-2"
          >
            Python 3.10+
          </a>
          .
        </Alert>

        {/*
          The whole setup, in one paste. It installs the agent, connects this PC,
          runs the first scan and sync, and registers the Claude Code session
          hooks. Nothing below it is required.
        */}
        <div className="mt-4">
          <div className="mb-1 flex flex-wrap items-baseline gap-2">
            <span className="text-base font-medium">Paste this into PowerShell</span>
            <span className="text-sm text-muted">on the PC you want to track</span>
          </div>
          <CodeBlock code={result.install_command} shell />
          <p className="mt-2 text-sm text-muted">
            Installs the agent, connects this PC, sends the first scan, and sets it to
            start and stop with your Claude Code sessions. Then you are done — this page
            updates by itself once it reports in.
          </p>
          {/*
            Said plainly, next to the command that actually does it — not buried
            in a step eight paragraphs down. This one line now shares more than
            token counts, and the earlier "only token counts" claim on the form
            above would be false the moment someone runs it.
          */}
          <p className="mt-1 text-sm text-muted">
            It also shares this PC's Claude account: email, org, plan tier, and the
            rate-limit percentages Claude Code already tracks — never prompts,
            responses, source code, or credentials. Turn it off any time, no reinstall,
            with <code className="rounded bg-surface-2 px-1">meterhouse account disable</code>{" "}
            on that PC.
          </p>
          {/*
            This line carries a single-use token that expires, which is easy to
            walk into now that it is the main path: paste it tomorrow and it
            fails with nothing to explain why. The API key inside the manual
            steps does not expire, so that is the honest fallback to point at.
          */}
          <p className="mt-1 text-sm text-muted">
            Works once, until <span className="font-medium text-ink-2">{expiresAt}</span>.
            After that, press “Connect another PC” for a fresh line — or use the steps
            below, which keep working because your API key does not expire.
          </p>

          {connectStatus && (
            <ConnectWaitStatusBlock status={connectStatus} onRetry={onRetryWait} />
          )}
        </div>

        <details className="mt-5 rounded-xl border border-line bg-surface-2 p-3">
          <summary className="cursor-pointer text-sm font-semibold">
            Prefer to run the steps yourself?
          </summary>

          <ol className="mt-4 flex flex-col gap-5">
            <Step n={1} title="Install the agent" code={AGENT_INSTALL}>
              Run once per PC. Commands use{" "}
              <code className="rounded bg-surface-2 px-1">python -m</code> because pip puts
              the <code className="rounded bg-surface-2 px-1">meterhouse</code> shortcut in
              a folder Windows leaves off PATH.
            </Step>

            <Step
              n={2}
              title="Connect this PC"
              code={connectCommand(serverUrl(), result.api_key, result.display_name)}
            >
              One command does the rest: registers this PC, runs the first scan and
              sync, shares Claude account + plan + rate-limit usage, starts the agent,
              and (on Windows) registers the scheduled task that keeps it running
              across reboots. Your API key is in this line and does not expire — keep
              it somewhere safe.
            </Step>

            <Step
              n={3}
              title="Report Claude account usage"
              optional
              code={accountReportCommands()}
            >
              Step 2 already does this (via <code className="rounded bg-surface-2 px-1">
              --account</code>). Only needed here if you skipped it, or want to check
              the payload first — <code className="rounded bg-surface-2 px-1">
              show</code> prints exactly what would be sent without sending it.
            </Step>

            <Step n={4} title="Watch it run" optional code={DAEMON_COMMAND}>
              Prints as it goes, which is useful for diagnosing a PC that is not reporting.
              Close the window (or run <code className="rounded bg-surface-2 px-1">
              meterhouse stop</code>) when you're done watching — step 2's scheduled task
              is what keeps it running unattended.
            </Step>
          </ol>

          <div className="mt-5 flex flex-col gap-3 border-t border-line pt-4">
            <CodeBlock code={result.api_key} label="API key" />
            <CodeBlock
              code={result.manual_commands}
              label="Full setup, including uninstall"
              shell
            />
          </div>
        </details>

        <p className="mt-4 text-sm text-muted">
          Not reporting? Run <code className="rounded bg-surface-2 px-1">{STATUS_COMMAND}</code>{" "}
          on that PC — it says whether the agent is running and what it last reported.
        </p>
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
        hint="One line to paste. Then it looks after itself."
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
        The generated command also shares this PC's Claude account — email, org, plan
        tier, and rate-limit usage — so it shows up fully set up with no second step.
        Prompts, responses, source code, and credentials are never read, and account
        sharing can be turned off on that PC any time.
      </p>
    </FormCard>
  );
}
