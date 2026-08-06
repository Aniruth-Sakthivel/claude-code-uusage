# Documentation Index

**Meterhouse** is original software for centralized Claude Code usage monitoring
across multiple PCs. It does **not** reuse, vendor, or depend on any third-party
project. Our own scanner was written from scratch against Claude Code's on-disk
JSONL format.

## Documents
- **[RUNNING.md](RUNNING.md)** — how to run the API, dashboard and agent locally,
  plus an end-to-end smoke test. Start here.
- **[DEPLOY.md](DEPLOY.md)** — deploying to Netlify as one site (static dashboard
  plus the API as a serverless function on the same origin).
- **[UPSTREAM_AUDIT.md](UPSTREAM_AUDIT.md)** — a **format reference** describing how
  Claude Code stores usage data on disk (independently observed from real
  transcripts). We use this *knowledge*, not anyone's code.
- **[CENTRALIZATION_PLAN.md](CENTRALIZATION_PLAN.md)** — the phased roadmap: local
  agent → sync → central API → central dashboard → auth → RBAC → Windows deploy.

## Two modes

**LOCAL mode (works today):**
```
Claude Code → agent scanner → ~/.claude/meterhouse/usage.db → CLI (scan/today/week/stats)
```
No central server required.

**CENTRALIZED mode (being added on top):**
```
Claude Code → agent scanner → local SQLite → Sync Agent → Central API → Central DB → React Dashboard
```
The scanner has **zero dependency** on the central server; local usage keeps
working if the server is down or never deployed.

## Important: tracked activity ≠ official quota

All numbers are **token counts parsed from local Claude Code transcript files** —
an observability *estimate*, **not** a reading of Anthropic's official Claude
Max/Pro quota consumption or billing. Dashboards keep this distinction explicit.

## What this project does **not** do
Does not modify Claude Code's own files, intercept its network traffic, scrape the
browser, or upload any prompts, responses, or source code — only usage metadata
and token counts.
