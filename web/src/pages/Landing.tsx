/** Public intro page. */

import { useEffect } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { Brand } from "../components/Layout";
import { Button, Card, CodeBlock, Eyebrow } from "../components/ui";
import { ThemeToggle } from "../lib/theme";

const AGENT_INSTALL_STEPS = [
  "# 1 - install the agent (once per PC)",
  "pip install claudefleet-agent",
  "",
  "# If 'claudefleet' is not recognized afterwards, pip installed it outside PATH.",
  "# Add the printed Scripts folder to PATH, or call it by full path.",
].join("\n");

const STEPS = [
  {
    n: "1",
    t: "Connect",
    d: "Run one command on each PC. It installs a small agent and schedules itself — no further setup.",
  },
  {
    n: "2",
    t: "Scan",
    d: "The agent reads Claude Code's own transcript files locally and counts tokens. No network interception, no browser scraping.",
  },
  {
    n: "3",
    t: "Rank",
    d: "The dashboard aggregates every machine and answers the question that matters: which PC is using the most.",
  },
];

export function Landing() {
  const { user, loading } = useAuth();

  useEffect(() => {
    document.title = "ClaudeFleet — Claude Code usage across your fleet";
  }, []);

  return (
    <div className="min-h-screen bg-plane">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-5 py-5">
        <Brand />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          {!loading &&
            (user ? (
              <Link to="/dashboard">
                <Button size="sm">Open dashboard</Button>
              </Link>
            ) : (
              <Link to="/login">
                <Button size="sm">Sign in</Button>
              </Link>
            ))}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 pb-20">
        <section className="py-12 sm:py-16">
          <Eyebrow>Fleet usage monitoring</Eyebrow>
          <h1 className="mt-2 max-w-3xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Which PC is generating the most Claude Code usage?
          </h1>
          <p className="mt-4 max-w-2xl text-base text-ink-2">
            ClaudeFleet reads the transcript files Claude Code already writes on each
            machine, and reports token activity across your whole fleet in one dashboard.
            Only counts and metadata are collected — never prompts, responses, or source
            code.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link to={user ? "/dashboard" : "/login"}>
              <Button>{user ? "Open dashboard" : "Get started"}</Button>
            </Link>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <Card key={s.n}>
              <div
                className="grid h-7 w-7 place-items-center rounded-lg text-sm font-bold text-white"
                style={{ background: "var(--accent)" }}
                aria-hidden
              >
                {s.n}
              </div>
              <h2 className="mt-3 text-lg font-semibold">{s.t}</h2>
              <p className="mt-1.5 text-sm text-ink-2">{s.d}</p>
            </Card>
          ))}
        </section>

        <section className="mt-10">
          <Card>
            <h2 className="text-lg font-semibold">Install the agent on this PC</h2>
            <p className="mt-1.5 max-w-2xl text-sm text-ink-2">
              Requires Python 3.10+ (get it from{" "}
              <a
                href="https://python.org/downloads"
                className="font-semibold text-accent underline underline-offset-2"
              >
                python.org
              </a>
              , ticking "Add python.exe to PATH"). You can install the agent now — connecting
              it to your dashboard and starting the background scan happens after you sign
              in, since that step needs your personal API key.
            </p>
            <div className="mt-4">
              <CodeBlock code={AGENT_INSTALL_STEPS} label="Step 1 — install" />
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link to={user ? "/dashboard" : "/login"}>
                <Button size="sm">
                  {user ? "Finish connecting this PC" : "Sign in to finish connecting"}
                </Button>
              </Link>
            </div>
          </Card>
        </section>

        <section className="mt-10">
          <Card>
            <h2 className="text-lg font-semibold">Tracked activity, not billing</h2>
            <p className="mt-1.5 max-w-3xl text-sm text-ink-2">
              All figures are token counts parsed from local transcript files. They are an
              observability estimate — not a reading of Anthropic's official Claude
              Max/Pro quota or billing.
            </p>
          </Card>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-5xl px-5 py-6 text-xs text-muted">
          ClaudeFleet — centralized Claude Code usage monitoring.
        </div>
      </footer>
    </div>
  );
}
