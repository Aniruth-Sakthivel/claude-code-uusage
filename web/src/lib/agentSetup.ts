/** Server URL the agent should register against (Netlify proxies /api/*). */
export function serverUrl(): string {
  return window.location.origin;
}

/**
 * Single-quoted PowerShell literal, with any embedded quote escaped — the
 * same convention the server uses for the generated one-liner (see
 * `pwshQuote` in `api/src/services/onboarding.ts`).
 *
 * Every command below is built as plain text for someone to paste into a
 * shell, not passed as an argv array — so an unquoted display name is exactly
 * as fragile as if it were typed by hand. `registerCommand` used to
 * interpolate `displayName` bare, and the very placeholder this form
 * suggests, "My Windows PC", broke it: PowerShell split the value into three
 * separate tokens at the spaces, and argparse rejected everything after the
 * first word as "unrecognized arguments".
 */
function pwshQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Commands are written as `python -m …`, never the bare `meterhouse` /`pip`
 * launchers.
 *
 * Those launchers are installed into the *user* Scripts directory whenever the
 * system Python directory isn't writable (the default without admin rights),
 * and Windows does not add that directory to PATH — so `meterhouse …` fails
 * with "not recognized" on a perfectly good install. Going through the
 * interpreter, which is already on PATH, sidesteps that entirely.
 */
export const AGENT_INSTALL = "python -m pip install --upgrade meterhouse-rotor";

/** Fallback when the package is not on PyPI yet — installs from the repo (needs git). */
export function agentInstallFromGit(repoUrl = "https://github.com/Aniruth-Sakthivel/claude-code-uusage.git"): string {
  return `python -m pip install "git+${repoUrl}#subdirectory=agent"`;
}

export function registerCommand(server: string, apiKey: string, displayName: string): string {
  return `python -m meterhouse register --server ${pwshQuote(server)} --api-key ${pwshQuote(apiKey)} --display-name ${pwshQuote(displayName)}`;
}

export function scanSyncCommands(): string {
  return "python -m meterhouse scan\npython -m meterhouse sync";
}

export const SCAN_COMMAND = "python -m meterhouse scan";
export const SYNC_COMMAND = "python -m meterhouse sync";

/**
 * Account reporting is off until switched on, and `show` prints the exact
 * payload without sending it — so the privacy claim can be checked rather than
 * trusted. The trailing sync is what actually transmits it.
 */
export function accountReportCommands(): string {
  return [
    "python -m meterhouse account show",
    "python -m meterhouse account enable",
    "python -m meterhouse sync",
  ].join("\n");
}

/**
 * The answer to "do I have to leave a window running?" — no.
 *
 * This registers Claude Code's own session hooks, so the agent starts when a
 * session starts and stops when the last one ends. It replaced a scheduled task
 * that ran a scan+sync every 15 minutes forever: that task polled 96 times a
 * day on machines where nobody had opened Claude Code at all, and it is what
 * the agent's own installer now removes on upgrade.
 */
export const INSTALL_HOOKS_COMMAND = "python -m meterhouse install-hooks";

/** Shows live sessions plus whether the hooks and agent are actually running —
 * the one command to run when a PC is not reporting. */
export const SESSIONS_COMMAND = "python -m meterhouse sessions";

/**
 * A once-a-day safety net, in case hook installation ever fails silently.
 * Scanning is incremental and idempotent, so a machine a day behind still
 * reports its full history.
 */
export const DAILY_CATCHUP_COMMAND = [
  "$py = (Get-Command python).Source",
  "$pyw = Join-Path (Split-Path $py) 'pythonw.exe'   # no console window",
  "$exe = if (Test-Path $pyw) { $pyw } else { $py }",
  "$act = New-ScheduledTaskAction -Execute $exe -Argument '-m meterhouse once --quiet'",
  "$trg = New-ScheduledTaskTrigger -Daily -At '12:30'",
  "Register-ScheduledTask -TaskName 'Meterhouse Daily Catch-up' -Action $act -Trigger $trg -Force",
].join("\n");

export function fullSetupBlock(opts: {
  server: string;
  apiKey: string;
  displayName: string;
  useGitFallback?: boolean;
  repoUrl?: string;
}): string {
  const install = opts.useGitFallback ? agentInstallFromGit(opts.repoUrl) : AGENT_INSTALL;
  return [
    `# 1 — Install agent (once per PC)`,
    install,
    ``,
    `# 2 — Connect this PC (once)`,
    registerCommand(opts.server, opts.apiKey, opts.displayName),
    ``,
    `# 3 — Scan local transcripts and send to dashboard`,
    scanSyncCommands(),
    ``,
    `# 4 — Start and stop with your Claude Code sessions`,
    INSTALL_HOOKS_COMMAND,
  ].join("\n");
}

export function windowsInstallScript(opts: {
  server: string;
  apiKey: string;
  displayName: string;
  scriptUrl?: string;
}): string {
  const url = opts.scriptUrl ?? `${opts.server}/install.ps1`;
  return `irm ${url} | iex -Args "-Server ${opts.server} -ApiKey ${opts.apiKey} -Name ${pwshQuote(opts.displayName)}"`;
}

const PENDING_KEY = "meterhouse_pending_api_key";
const PENDING_NAME = "meterhouse_pending_display_name";

export function stashConnectInfo(apiKey: string, displayName?: string): void {
  sessionStorage.setItem(PENDING_KEY, apiKey);
  if (displayName) sessionStorage.setItem(PENDING_NAME, displayName);
}

export function readStashedConnect(): { apiKey: string | null; displayName: string | null } {
  return {
    apiKey: sessionStorage.getItem(PENDING_KEY),
    displayName: sessionStorage.getItem(PENDING_NAME),
  };
}

export function clearStashedConnect(): void {
  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_NAME);
}

/**
 * Run the agent in the foreground to watch it work.
 *
 * It scans while a Claude Code session is open and exits on its own when the
 * last one ends — so this is a diagnostic, not the way to keep a PC reporting.
 * The hooks do that. (`--always-on` restores the old run-forever behaviour for
 * machines whose settings.json is locked down by policy.)
 */
export const DAEMON_COMMAND = "python -m meterhouse daemon";
