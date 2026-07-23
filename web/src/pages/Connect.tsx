import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import type { SystemCreated, SystemRow } from "../api/types";
import { ConnectInstructions } from "../components/ConnectInstructions";
import { Button, Card, CardHead, EmptyState, Spinner } from "../components/ui";
import { clearStashedConnect, readStashedConnect, stashConnectInfo } from "../lib/agentSetup";

const ENVIRONMENTS = ["", "dev", "build", "lab", "prod", "other"];
const field = "w-full rounded-lg border px-3 py-2.5 text-[14px] outline-none";
const fieldStyle = { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--ink)" };

export function Connect() {
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const canManageKeys = can("manage_keys");

  const systems = useQuery({
    queryKey: ["systems"],
    queryFn: () => api.get<SystemRow[]>("/api/v1/systems"),
  });

  const assigned = (systems.data ?? []).filter(
    (s) => user?.role !== "developer" || (user.system_ids ?? []).includes(s.system_id),
  );

  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [createForm, setCreateForm] = useState({
    display_name: "", owner: "", location: "", environment: "", notes: "",
  });
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    const stashed = readStashedConnect();
    if (stashed.apiKey) setApiKey(stashed.apiKey);
    if (stashed.displayName) {
      setDisplayName(stashed.displayName);
      setCreateForm((f) => ({ ...f, display_name: stashed.displayName! }));
    } else if (assigned.length === 1) {
      setDisplayName(assigned[0].display_name);
    }
  }, [systems.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const createSystem = useMutation({
    mutationFn: () => api.post<SystemCreated>("/api/v1/admin/systems", createForm),
    onSuccess: (res) => {
      setApiKey(res.api_key);
      setDisplayName(res.system.display_name);
      stashConnectInfo(res.api_key, res.system.display_name);
      qc.invalidateQueries({ queryKey: ["systems"] });
      setCreateError(null);
    },
    onError: (e: Error) => setCreateError(e.message),
  });

  function onSystemPick(id: string) {
    const sys = assigned.find((s) => s.system_id === id);
    if (sys) setDisplayName(sys.display_name);
  }

  return (
    <div>
      <h2 className="mb-1 text-[21px] font-semibold tracking-tight">Connect this PC</h2>
      <p className="mb-5 text-[13.5px]" style={{ color: "var(--ink-2)" }}>
        Install the ClaudeFleet agent on each machine where Claude Code runs. You only need this
        dashboard URL — no full project download required.
      </p>

      <div className="mb-5 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHead title="Your settings" hint="Used in the commands below" />
          <div className="flex flex-col gap-3">
            {assigned.length > 1 && (
              <label className="text-[12.5px] font-medium">Assigned system
                <select className={field + " mt-1"} style={fieldStyle}
                  value={assigned.find((s) => s.display_name === displayName)?.system_id ?? ""}
                  onChange={(e) => onSystemPick(e.target.value)}>
                  <option value="">— pick —</option>
                  {assigned.map((s) => (
                    <option key={s.system_id} value={s.system_id}>{s.display_name}</option>
                  ))}
                </select>
              </label>
            )}

            <label className="text-[12.5px] font-medium">PC name (display name)
              <input className={field + " mt-1"} style={fieldStyle} placeholder="e.g. PC-02"
                value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>

            <label className="text-[12.5px] font-medium">Agent API key
              <input className={field + " mt-1 font-mono text-[13px]"} style={fieldStyle}
                placeholder="cfk_… (from your admin)" value={apiKey}
                onChange={(e) => setApiKey(e.target.value)} />
            </label>

            {apiKey && (
              <Button variant="ghost" onClick={() => { setApiKey(""); clearStashedConnect(); }}>
                Clear key
              </Button>
            )}

            {!canManageKeys && assigned.length === 0 && systems.isSuccess && (
              <EmptyState
                title="No systems assigned"
                hint="Ask an administrator to create your account, assign a system, and give you an API key."
              />
            )}

            {!canManageKeys && assigned.length > 0 && !apiKey && (
              <p className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                Your admin enrolled{" "}
                <b>{assigned.map((s) => s.display_name).join(", ")}</b>.
                Paste the API key they sent you above.
              </p>
            )}
          </div>
        </Card>

        {canManageKeys && (
          <Card>
            <CardHead title="Enroll a new PC" hint="Admin only" />
            <p className="mb-3 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
              Create a system and API key for a new machine. The key is shown once — copy it
              immediately.
            </p>
            <div className="flex flex-col gap-3">
              <label className="text-[12.5px] font-medium">System name
                <input className={field + " mt-1"} style={fieldStyle} placeholder="e.g. PC-03"
                  value={createForm.display_name}
                  onChange={(e) => setCreateForm({ ...createForm, display_name: e.target.value })} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-[12.5px] font-medium">Owner
                  <input className={field + " mt-1"} style={fieldStyle} placeholder="Person"
                    value={createForm.owner}
                    onChange={(e) => setCreateForm({ ...createForm, owner: e.target.value })} />
                </label>
                <label className="text-[12.5px] font-medium">Location
                  <input className={field + " mt-1"} style={fieldStyle} placeholder="Office"
                    value={createForm.location}
                    onChange={(e) => setCreateForm({ ...createForm, location: e.target.value })} />
                </label>
              </div>
              <label className="text-[12.5px] font-medium">Environment
                <select className={field + " mt-1"} style={fieldStyle} value={createForm.environment}
                  onChange={(e) => setCreateForm({ ...createForm, environment: e.target.value })}>
                  {ENVIRONMENTS.map((e) => (
                    <option key={e} value={e}>{e === "" ? "— none —" : e}</option>
                  ))}
                </select>
              </label>
              {createError && (
                <div className="text-[12.5px]" style={{ color: "var(--critical)" }}>{createError}</div>
              )}
              <Button
                onClick={() => createSystem.mutate()}
                disabled={!createForm.display_name.trim() || createSystem.isPending}>
                {createSystem.isPending ? "Creating…" : "Create system + key"}
              </Button>
            </div>
          </Card>
        )}
      </div>

      <Card>
        <CardHead title="Run on this PC" hint="PowerShell or terminal" />
        {systems.isLoading ? <Spinner /> : (
          <ConnectInstructions apiKey={apiKey} displayName={displayName || "PC-01"} />
        )}
      </Card>

      <p className="mt-4 text-[12px]" style={{ color: "var(--muted)" }}>
        After running scan + sync, open{" "}
        <Link to="/dashboard" style={{ color: "var(--accent)" }}>Overview</Link>{" "}
        to see usage. Schedule scan every 15 minutes with Task Scheduler — see{" "}
        <code className="text-[11px]">deploy/install.ps1</code> for an automated setup.
      </p>
    </div>
  );
}
