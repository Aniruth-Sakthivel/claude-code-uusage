/** Server URL the agent should register against (Netlify proxies /api/*). */
export function serverUrl(): string {
  return window.location.origin;
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
  return `python -m meterhouse register --server ${server} --api-key ${apiKey} --display-name ${displayName}`;
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
 * Scheduled task that keeps a PC reporting with no terminal open — the answer
 * to "do I have to leave this window running?". `meterhouse daemon` is the
 * foreground alternative and dies with its terminal, so it is not offered here
 * as the way to keep a machine connected.
 */
export const BACKGROUND_TASK_COMMAND = [
  "$py = (Get-Command python).Source",
  'schtasks /Create /SC MINUTE /MO 15 /TN "Meterhouse Scan+Sync" /F /ST 00:00 ' +
    '/TR "cmd /c $py -m meterhouse scan --quiet && $py -m meterhouse sync --quiet"',
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
  ].join("\n");
}

export function windowsInstallScript(opts: {
  server: string;
  apiKey: string;
  displayName: string;
  scriptUrl?: string;
}): string {
  const url = opts.scriptUrl ?? `${opts.server}/install.ps1`;
  return `irm ${url} | iex -Args "-Server ${opts.server} -ApiKey ${opts.apiKey} -Name ${opts.displayName}"`;
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
 * Foreground daemon. Dies with its terminal, so it is offered as a deliberate
 * alternative to the scheduled task rather than as a way to keep a PC
 * reporting — and it is the only path that reports Claude account usage on
 * agent 0.1.2 and older.
 */
export const DAEMON_COMMAND = "python -m meterhouse daemon";
