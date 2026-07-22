import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../lib/useTheme";

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border px-3.5 py-3 text-[12.5px] leading-relaxed"
      style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--ink)" }}>
      <code>{children}</code>
    </pre>
  );
}

const STEPS = [
  { n: "1", t: "Scan", d: "A tiny agent on each PC reads Claude Code's local transcript files and counts tokens — no network interception, no prompts or code ever leave the machine." },
  { n: "2", t: "Sync", d: "The agent pushes only usage metadata to the central API over its own API key. Events are deduplicated, so nothing is ever counted twice." },
  { n: "3", t: "Rank", d: "The dashboard aggregates every machine and answers the one question that matters: which PC is generating the most tracked token activity." },
];

export function Landing() {
  const { user } = useAuth();
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen">
      {/* top bar */}
      <header className="mx-auto flex max-w-[1080px] items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-lg text-[14px] font-bold text-white"
            style={{ background: "linear-gradient(135deg, var(--pc1), var(--accent))" }}>CF</div>
          <span className="text-[16px] font-semibold">ClaudeFleet</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggle} aria-label="Toggle theme"
            className="grid h-9 w-9 place-items-center rounded-lg border"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--ink-2)" }}>
            {dark ? "☀" : "☾"}
          </button>
          <button onClick={() => navigate(user ? "/dashboard" : "/login")}
            className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white" style={{ background: "var(--accent)" }}>
            {user ? "Open dashboard" : "Sign in"}
          </button>
        </div>
      </header>

      {/* hero */}
      <section className="mx-auto max-w-[1080px] px-6 pb-6 pt-10">
        <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11.5px] font-medium"
          style={{ borderColor: "var(--border)", color: "var(--ink-2)" }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--good)" }} />
          Centralized Claude Code usage monitoring
        </div>
        <h1 className="mt-4 max-w-[720px] text-[40px] font-semibold leading-[1.08] tracking-[-0.02em]" style={{ textWrap: "balance" }}>
          Know which PC is generating the most Claude Code activity.
        </h1>
        <p className="mt-4 max-w-[620px] text-[16px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
          ClaudeFleet scans each machine's local usage, syncs the metadata to one place, and ranks your
          fleet — so you can see at a glance where the tokens are going across PC-01, PC-02, and PC-03.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button onClick={() => navigate(user ? "/dashboard" : "/login")}
            className="rounded-lg px-5 py-2.5 text-[14px] font-semibold text-white" style={{ background: "var(--accent)" }}>
            {user ? "Open dashboard →" : "Sign in →"}
          </button>
          <a href="#get-started" className="rounded-lg border px-5 py-2.5 text-[14px] font-semibold"
            style={{ borderColor: "var(--border)", color: "var(--ink)" }}>How to run it</a>
        </div>
        <p className="mt-4 text-[12px]" style={{ color: "var(--muted)" }}>
          Tracked activity is an estimate parsed from local transcripts — not official Claude Max/Pro quota or billing.
        </p>
      </section>

      {/* how it works */}
      <section className="mx-auto max-w-[1080px] px-6 py-10">
        <div className="grid gap-4 md:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="rounded-2xl border p-5"
              style={{ background: "var(--surface)", borderColor: "var(--border)", boxShadow: "var(--shadow)" }}>
              <div className="grid h-8 w-8 place-items-center rounded-lg text-[13px] font-bold"
                style={{ background: "var(--accent-weak)", color: "var(--accent)" }}>{s.n}</div>
              <h3 className="mt-3 text-[15px] font-semibold">{s.t}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* getting started */}
      <section id="get-started" className="mx-auto max-w-[1080px] px-6 py-10">
        <h2 className="text-[22px] font-semibold tracking-tight">Get started in three steps</h2>
        <p className="mt-1.5 text-[14px]" style={{ color: "var(--ink-2)" }}>
          Run the Python backend once — it creates its database and an admin account automatically.
        </p>

        <div className="mt-6 grid gap-5 md:grid-cols-3">
          <div>
            <h3 className="mb-2 text-[14px] font-semibold">1 · Start the server (run once)</h3>
            <Code>{`cd server
pip install -e .
python run.py`}</Code>
            <p className="mt-2 text-[12px]" style={{ color: "var(--ink-2)" }}>
              Starts the API on <b>:8000</b>. On first run you'll create your admin
              account in the web app (step 2).
            </p>
          </div>
          <div>
            <h3 className="mb-2 text-[14px] font-semibold">2 · Open the dashboard</h3>
            <Code>{`cd web
npm install
npm run dev`}</Code>
            <p className="mt-2 text-[12px]" style={{ color: "var(--ink-2)" }}>
              Visit <b>http://localhost:5173</b>, create the admin account, then name your first machine.
            </p>
          </div>
          <div>
            <h3 className="mb-2 text-[14px] font-semibold">3 · Scan a PC</h3>
            <Code>{`cd agent
python -m claudefleet scan
python -m claudefleet register \\
  --server http://SERVER:8000 \\
  --api-key <key> --display-name PC-01
python -m claudefleet sync`}</Code>
            <p className="mt-2 text-[12px]" style={{ color: "var(--ink-2)" }}>
              The key comes from the setup panel after you sign in.
            </p>
          </div>
        </div>

        <div className="mt-8">
          <button onClick={() => navigate(user ? "/dashboard" : "/login")}
            className="rounded-lg px-5 py-2.5 text-[14px] font-semibold text-white" style={{ background: "var(--accent)" }}>
            {user ? "Open dashboard →" : "Sign in to continue →"}
          </button>
        </div>
      </section>

      <footer className="mx-auto max-w-[1080px] border-t px-6 py-8 text-[12px]"
        style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
        ClaudeFleet · local scanning works offline · only usage metadata is ever synced —
        never prompts, responses, or source code. <Link to="/login" style={{ color: "var(--accent)" }}>Sign in</Link>
      </footer>
    </div>
  );
}
