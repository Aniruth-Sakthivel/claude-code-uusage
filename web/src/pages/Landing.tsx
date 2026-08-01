import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Building2, ShieldCheck, Sparkles } from "lucide-react";

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
    d: "Run one command on each workstation. It installs a discreet agent and schedules itself with no further attention.",
    icon: Building2,
  },
  {
    n: "2",
    t: "Observe",
    d: "The agent reads Claude Code's transcript files locally and composes the usage story without touching prompts or content.",
    icon: Sparkles,
  },
  {
    n: "3",
    t: "Understand",
    d: "The dashboard surfaces the highest usage, the quietest periods, and the systems that deserve attention.",
    icon: ShieldCheck,
  },
];

export function Landing() {
  const { user, loading } = useAuth();

  useEffect(() => {
    document.title = "Aurelia — Private observability";
  }, []);

  return (
    <div className="min-h-screen bg-plane">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-5 sm:px-7 lg:px-8">
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

      <main className="mx-auto max-w-6xl px-5 pb-20 sm:px-7 lg:px-8">
        <section className="rounded-[32px] border border-line bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(244,242,238,0.95))] px-6 py-10 shadow-[var(--shadow)] sm:px-8 lg:px-10 lg:py-14">
          <Eyebrow>Quiet luxury observability</Eyebrow>
          <h1 className="mt-3 max-w-3xl font-serif text-4xl font-semibold leading-[1.05] tracking-[-0.02em] text-ink sm:text-5xl">
            A refined place to understand every connected workspace.
          </h1>
          <p className="mt-4 max-w-2xl text-base text-ink-2">
            Aurelia transforms local Claude Code usage into a calm, premium command center — elegant enough for a private studio, practical enough for a modern team.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link to={user ? "/dashboard" : "/login"}>
              <Button>
                {user ? "Open dashboard" : "Get started"}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </section>

        <section className="mt-8 grid gap-4 lg:grid-cols-3">
          {STEPS.map((s) => {
            const Icon = s.icon;
            return (
              <Card key={s.n} className="p-5">
                <div className="grid h-9 w-9 place-items-center rounded-full border border-line bg-surface-2 text-accent" aria-hidden>
                  <Icon className="h-4 w-4" />
                </div>
                <h2 className="mt-4 text-lg font-semibold text-ink">{s.t}</h2>
                <p className="mt-2 text-sm text-ink-2">{s.d}</p>
              </Card>
            );
          })}
        </section>

        <section className="mt-8">
          <Card className="p-6 sm:p-8">
            <h2 className="text-xl font-semibold text-ink">Install the agent on this workstation</h2>
            <p className="mt-2 max-w-2xl text-sm text-ink-2">
              Requires Python 3.10+ (get it from <a href="https://python.org/downloads" className="font-semibold text-accent underline underline-offset-2">python.org</a>, ticking “Add python.exe to PATH”). You can install the agent now — connecting it to your dashboard and starting the background scan happens after you sign in.
            </p>
            <div className="mt-4">
              <CodeBlock code={AGENT_INSTALL_STEPS} label="Step 1 — install" />
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link to={user ? "/dashboard" : "/login"}>
                <Button size="sm">{user ? "Finish connecting this PC" : "Sign in to finish connecting"}</Button>
              </Link>
            </div>
          </Card>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-6xl px-5 py-6 text-xs text-muted sm:px-7 lg:px-8">
          Aurelia — private observability for modern creative teams.
        </div>
      </footer>
    </div>
  );
}
