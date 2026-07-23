import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { Button } from "../components/ui";

const field = "w-full rounded-lg border px-3 py-2.5 text-[14px] outline-none";
const fieldStyle = { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--ink)" };

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState<boolean | null>(null);
  const [form, setForm] = useState({ email: "", full_name: "", password: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ open: boolean }>("/api/v1/auth/registration-open")
      .then((r) => setOpen(r.open))
      .catch(() => setOpen(false));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) { setError("Passwords don't match."); return; }
    if (form.password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setBusy(true); setError(null);
    try {
      await register(form.email, form.full_name, form.password);
      navigate("/connect");
    } catch (err) {
      setError((err as Error).message || "Registration failed.");
    } finally { setBusy(false); }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl text-lg font-bold text-white"
            style={{ background: "linear-gradient(135deg, var(--pc1), var(--accent))" }}>CF</div>
          <div>
            <div className="text-lg font-semibold leading-tight">ClaudeFleet</div>
            <div className="text-[12px]" style={{ color: "var(--muted)" }}>First-run setup</div>
          </div>
        </div>

        <div className="rounded-2xl border p-6" style={{ background: "var(--surface)", borderColor: "var(--border)", boxShadow: "var(--shadow)" }}>
          {open === null ? (
            <div className="py-6 text-center text-sm" style={{ color: "var(--muted)" }}>Checking…</div>
          ) : !open ? (
            <div>
              <h1 className="mb-1 text-[17px] font-semibold">Registration is closed</h1>
              <p className="text-[13px]" style={{ color: "var(--ink-2)" }}>
                An administrator already exists. Ask an admin to create your account, then
                sign in with the credentials they give you, then go to{" "}
                <strong>Connect PC</strong> in the sidebar to install the agent on your machine.
              </p>
              <div className="mt-5"><Link to="/login"><Button>Go to sign in</Button></Link></div>
            </div>
          ) : (
            <>
              <h1 className="mb-1 text-[17px] font-semibold">Create the admin account</h1>
              <p className="mb-5 text-[13px]" style={{ color: "var(--ink-2)" }}>
                This is the first account, so it becomes the administrator. You can add more
                users afterwards from the dashboard.
              </p>
              <form onSubmit={onSubmit} className="flex flex-col gap-3">
                <label className="text-[12.5px] font-medium">Full name
                  <input className={field + " mt-1"} style={fieldStyle} value={form.full_name}
                    onChange={set("full_name")} placeholder="Your name" autoFocus />
                </label>
                <label className="text-[12.5px] font-medium">Email
                  <input className={field + " mt-1"} style={fieldStyle} type="email" value={form.email}
                    onChange={set("email")} required />
                </label>
                <label className="text-[12.5px] font-medium">Password
                  <input className={field + " mt-1"} style={fieldStyle} type="password" value={form.password}
                    onChange={set("password")} required />
                </label>
                <label className="text-[12.5px] font-medium">Confirm password
                  <input className={field + " mt-1"} style={fieldStyle} type="password" value={form.confirm}
                    onChange={set("confirm")} required />
                </label>
                {error && <div className="text-[12.5px]" style={{ color: "var(--critical)" }}>{error}</div>}
                <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create admin & continue"}</Button>
              </form>
              <p className="mt-4 text-center text-[12px]" style={{ color: "var(--muted)" }}>
                Already have an account? <Link to="/login" style={{ color: "var(--accent)" }}>Sign in</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
