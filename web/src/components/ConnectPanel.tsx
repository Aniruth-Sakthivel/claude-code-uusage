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

import { api } from "../api/client";
import { fleetKeys } from "../api/queryKeys";
import type { ConnectResponse, SystemRow } from "../api/types";
import {
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

        <ol className="flex flex-col gap-4">
          <li>
            <div className="mb-2 text-base font-medium">
              1. Open <span className="font-semibold">PowerShell</span> on the PC you want
              to track
            </div>
            <p className="text-sm text-muted">
              Press <kbd className="rounded border border-line px-1">Win</kbd> +{" "}
              <kbd className="rounded border border-line px-1">X</kbd>, then choose
              Terminal or PowerShell. Needs{" "}
              <a
                href="https://python.org/downloads"
                className="font-semibold text-accent underline underline-offset-2"
              >
                Python 3.10+
              </a>{" "}
              on PATH.
            </p>
          </li>

          <li>
            <div className="mb-2 text-base font-medium">2. Install the agent</div>
            <CodeBlock code="pip install claudefleet-agent" label="Install" />
            <p className="mt-2 text-sm text-muted">
              If <code className="rounded bg-surface-2 px-1">claudefleet</code> isn't
              recognized afterwards, pip installed it outside PATH — add the printed
              Scripts folder to PATH, or call it by full path.
            </p>
          </li>

          <li>
            <div className="mb-2 text-base font-medium">3. Connect, then scan and sync</div>
            <CodeBlock code={result.manual_commands} label="Register, scan & sync" />
            <p className="mt-2 text-sm text-muted">
              Your API key is baked into the <code className="rounded bg-surface-2 px-1">register</code>{" "}
              command above — it doesn't expire, so store this block somewhere safe. For quick
              copying without the rest of the block:
            </p>
            <div className="mt-2">
              <CodeBlock code={result.api_key} label="API key" />
            </div>
          </li>
        </ol>
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
