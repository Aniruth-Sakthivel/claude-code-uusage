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
        <h2 className="text-[22px] font-semibold tracking-tight">Get started</h2>
        <p className="mt-1.5 text-[14px]" style={{ color: "var(--ink-2)" }}>
          Most users only need the dashboard URL and an API key — no full project download.
        </p>

        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border p-5"
            style={{ background: "var(--surface)", borderColor: "var(--border)", boxShadow: "var(--shadow)" }}>
            <h3 className="mb-1 text-[15px] font-semibold">For PC users</h3>
            <p className="mb-4 text-[13px]" style={{ color: "var(--ink-2)" }}>
              Sign in, open <b>Connect PC</b>, paste your API key, and run the commands on your machine.
            </p>
            <Code>{`pip install claudefleet-agent
claudefleet register --server ${typeof window !== "undefined" ? window.location.origin : "https://YOUR-SITE"} \\
  --api-key cfk_... --display-name PC-01
claudefleet scan
claudefleet sync`}</Code>
            <p className="mt-3 text-[12px]" style={{ color: "var(--ink-2)" }}>
              Your admin creates your login and sends the API key. Scanning runs locally — the browser cannot do it.
            </p>
          </div>

          <div className="rounded-2xl border p-5"
            style={{ background: "var(--surface)", borderColor: "var(--border)", boxShadow: "var(--shadow)" }}>
            <h3 className="mb-1 text-[15px] font-semibold">For administrators (self-hosting)</h3>
            <p className="mb-4 text-[13px]" style={{ color: "var(--ink-2)" }}>
              Deploy the API and dashboard once, then enroll each PC from Connect PC or Admin → Agent API keys.
            </p>
            <Code>{`cd server && pip install -e . && python run.py
cd web && npm install && npm run dev`}</Code>
            <p className="mt-3 text-[12px]" style={{ color: "var(--ink-2)" }}>
              See <code>docs/DEPLOY.md</code> for Netlify + Render production deployment.
            </p>
          </div>
        </div>

        <div className="mt-8">
          <button onClick={() => navigate(user ? "/connect" : "/login")}
            className="rounded-lg px-5 py-2.5 text-[14px] font-semibold text-white" style={{ background: "var(--accent)" }}>
            {user ? "Connect a PC →" : "Sign in to continue →"}
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
