import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import type { SystemCreated } from "../api/types";
import { Button } from "../components/ui";

const ENVIRONMENTS = ["", "dev", "build", "lab", "prod", "other"];

const field = "w-full rounded-lg border px-3 py-2.5 text-[14px] outline-none";
const fieldStyle = { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--ink)" };

export function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<"signin" | "setup">("signin");

  // Already signed in and visiting /login: admins get the setup panel, others go home.
  useEffect(() => {
    if (user) user.role === "admin" ? setPhase("setup") : navigate("/dashboard");
  }, [user, navigate]);

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl text-lg font-bold text-white"
            style={{ background: "linear-gradient(135deg, var(--pc1), var(--accent))" }}>CF</div>
          <div>
            <div className="text-lg font-semibold leading-tight">ClaudeFleet</div>
            <div className="text-[12px]" style={{ color: "var(--muted)" }}>Usage monitoring platform</div>
          </div>
        </div>

        {phase === "signin"
          ? <SignInCard onDone={(role) => (role === "admin" ? setPhase("setup") : navigate("/dashboard"))} login={login} />
          : <SetupCard onContinue={() => navigate("/dashboard")} />}

        <p className="mt-4 text-center text-[11.5px]" style={{ color: "var(--muted)" }}>
          Tracked activity is an estimate — not official Claude Max/Pro quota.
        </p>
      </div>
    </div>
  );
}

function SignInCard({ onDone, login }: {
  onDone: (role: string) => void;
  login: (e: string, p: string) => Promise<{ role: string }>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const me = await login(email, password);
      onDone(me.role);
    } catch {
      setError("Invalid email or password.");
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded-2xl border p-6" style={{ background: "var(--surface)", borderColor: "var(--border)", boxShadow: "var(--shadow)" }}>
      <h1 className="mb-1 text-[17px] font-semibold">Sign in</h1>
      <p className="mb-5 text-[13px]" style={{ color: "var(--ink-2)" }}>Access your fleet dashboard.</p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="text-[12.5px] font-medium">Email
          <input className={field + " mt-1"} style={fieldStyle} type="email" value={email}
            onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label className="text-[12.5px] font-medium">Password
          <input className={field + " mt-1"} style={fieldStyle} type="password" value={password}
            onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="text-[12.5px]" style={{ color: "var(--critical)" }}>{error}</div>}
        <Button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <p className="mt-4 text-center text-[12px]" style={{ color: "var(--muted)" }}>
        First-time setup? <Link to="/register" style={{ color: "var(--accent)" }}>Create the admin account</Link>
      </p>
    </div>
  );
}

function SetupCard({ onContinue }: { onContinue: () => void }) {
  const [form, setForm] = useState({ display_name: "", owner: "", location: "", environment: "", notes: "" });
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit() {
    if (!form.display_name.trim()) { setError("Give the machine a name (e.g. PC-01)."); return; }
    setBusy(true); setError(null);
    try {
      const res = await api.post<SystemCreated>("/api/v1/admin/systems", form);
      setApiKey(res.api_key);
      setCreated(res.system.display_name);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  function addAnother() {
    setForm({ display_name: "", owner: "", location: "", environment: "", notes: "" });
    setApiKey(null); setCreated(null);
  }

  return (
    <div className="rounded-2xl border p-6" style={{ background: "var(--surface)", borderColor: "var(--border)", boxShadow: "var(--shadow)" }}>
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-[17px] font-semibold">Set up this machine</h1>
        <button onClick={onContinue} className="text-[12.5px] font-semibold" style={{ color: "var(--accent)" }}>Skip →</button>
      </div>
      <p className="mb-5 text-[13px]" style={{ color: "var(--ink-2)" }}>
        Name the PC and add its details. You'll get an agent API key to connect it.
      </p>

      {apiKey ? (
        <div>
          <div className="mb-3 rounded-xl border p-4" style={{ background: "var(--accent-weak)", borderColor: "var(--accent)" }}>
            <div className="mb-1 text-[12.5px] font-semibold" style={{ color: "var(--accent)" }}>
              “{created}” created. Copy its API key now — it won't be shown again.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg px-3 py-2 text-[12.5px]"
                style={{ background: "var(--surface)", color: "var(--ink)" }}>{apiKey}</code>
              <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(apiKey)}>Copy</Button>
            </div>
            <div className="mt-2 text-[11.5px]" style={{ color: "var(--ink-2)" }}>
              On that PC run: <code>claudefleet register --server &lt;url&gt; --api-key {apiKey.slice(0, 12)}…</code>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={onContinue}>Continue to dashboard</Button>
            <Button variant="ghost" onClick={addAnother}>Add another system</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="text-[12.5px] font-medium">System name
            <input className={field + " mt-1"} style={fieldStyle} placeholder="e.g. PC-01" value={form.display_name}
              onChange={set("display_name")} autoFocus />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-[12.5px] font-medium">Owner
              <input className={field + " mt-1"} style={fieldStyle} placeholder="Assigned person" value={form.owner} onChange={set("owner")} />
            </label>
            <label className="text-[12.5px] font-medium">Location
              <input className={field + " mt-1"} style={fieldStyle} placeholder="Office / team" value={form.location} onChange={set("location")} />
            </label>
          </div>
          <label className="text-[12.5px] font-medium">Environment
            <select className={field + " mt-1"} style={fieldStyle} value={form.environment} onChange={set("environment")}>
              {ENVIRONMENTS.map((e) => <option key={e} value={e}>{e === "" ? "— none —" : e}</option>)}
            </select>
          </label>
          <label className="text-[12.5px] font-medium">Notes
            <textarea className={field + " mt-1"} style={fieldStyle} rows={2} placeholder="Anything useful about this machine" value={form.notes} onChange={set("notes")} />
          </label>
          {error && <div className="text-[12.5px]" style={{ color: "var(--critical)" }}>{error}</div>}
          <div className="flex gap-2">
            <Button onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create system + key"}</Button>
            <Button variant="ghost" onClick={onContinue}>Continue to dashboard</Button>
          </div>
        </div>
      )}
    </div>
  );
}
