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
export function agentInstallFromGit(repoUrl = "https://github.com/Aniruth-Sakthivel/claude-code-uusage.git"): string {
  return `python -m pip install "git+${repoUrl}#subdirectory=agent" --force-reinstall`;
}

/**
 * Installs from git, not PyPI — deliberately, not stylistically.
 * `meterhouse-rotor` on PyPI is a real, successfully-installable release
 * (0.3.0) that predates the always-on daemon rebuild: `pip install
 * --upgrade meterhouse-rotor` against it exits 0, so a PyPI-first install
 * silently succeeds while shipping the *old* session-gated agent (no
 * `daemon`/`status`/`connect`; scans once and exits when it thinks a Claude
 * Code session ended). There is no version check anywhere in this flow that
 * could catch that — the old build reports itself installed successfully
 * because it genuinely is. Revert to plain PyPI once `meterhouse-rotor` is
 * republished at a version that includes the daemon rebuild.
 */
export const AGENT_INSTALL = agentInstallFromGit();

/** The old PyPI-only install — kept only as a documented fallback for when
 * git isn't available; not used as the default, see `AGENT_INSTALL`. */
export const AGENT_INSTALL_FROM_PYPI = "python -m pip install --upgrade meterhouse-rotor";

export function registerCommand(server: string, apiKey: string, displayName: string): string {
  return `python -m meterhouse register --server ${pwshQuote(server)} --api-key ${pwshQuote(apiKey)} --display-name ${pwshQuote(displayName)}`;
}

/**
 * Everything below in one command: register, first scan, first sync, start
 * the agent, and (on Windows) register the scheduled-task supervisor.
 * `--account` also turns on Claude account reporting in the same step.
 */
export function connectCommand(server: string, apiKey: string, displayName: string): string {
  return `python -m meterhouse connect --server ${pwshQuote(server)} --api-key ${pwshQuote(apiKey)} --display-name ${pwshQuote(displayName)} --account`;
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
 * There are no Claude Code session hooks — the agent is a single persistent
 * process, started once and kept alive by a scheduled task that relaunches it
 * (harmlessly, if one is already running) roughly every minute, so it survives
 * a reboot or crash without depending on Claude Code being open at all.
 */
export const START_AGENT_COMMAND = [
  "$py = (Get-Command python).Source",
  "$pyw = Join-Path (Split-Path $py) 'pythonw.exe'   # no console window",
  "$exe = if (Test-Path $pyw) { $pyw } else { $py }",
  "Start-Process -FilePath $exe -ArgumentList '-m meterhouse daemon' -WindowStyle Hidden",
].join("\n");

/** Keeps the agent running across reboots and relaunches it if it ever dies —
 * every relaunch attempt while one is already running exits in milliseconds,
 * which is what makes a 1-minute repeating trigger safe to register.
 *
 * No `-RepetitionDuration`: that's what makes the repeat indefinite.
 * `[TimeSpan]::MaxValue` used to be passed there to mean "forever", but Task
 * Scheduler serializes it as an ISO 8601 duration and MaxValue overflows the
 * schema's range — the task registered but then failed to run with "The task
 * XML contains a value which is incorrectly formatted or out of range",
 * which is why the agent stopped surviving reboots. Omitting the parameter
 * avoids the conversion entirely. */
export const REGISTER_SUPERVISOR_COMMAND = [
  "$py = (Get-Command python).Source",
  "$pyw = Join-Path (Split-Path $py) 'pythonw.exe'",
  "$exe = if (Test-Path $pyw) { $pyw } else { $py }",
  "$act = New-ScheduledTaskAction -Execute $exe -Argument '-m meterhouse daemon'",
  "$logon = New-ScheduledTaskTrigger -AtLogOn",
  "$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)",
  // Elevated -> a real SYSTEM principal, so the task runs machine-wide with
  // no login required. Not elevated -> no -Principal at all, which lets
  // Register-ScheduledTask default to this process's own token; passing an
  // explicit Principal (even one asking for no more than that token already
  // has) routes registration through a code path that needs elevation and
  // fails with "Access is denied" without it.
  "$isElevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  "if ($isElevated) {",
  "  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
  "  Register-ScheduledTask -TaskName 'Meterhouse Agent' -Action $act -Trigger @($logon, $repeat) -Principal $principal -Force",
  "} else {",
  "  Register-ScheduledTask -TaskName 'Meterhouse Agent' -Action $act -Trigger @($logon, $repeat) -Force",
  "}",
  "Get-ScheduledTask -TaskName 'Meterhouse Agent'   # verify it actually registered",
].join("\n");

/** Shows whether the agent is currently running and what it last reported —
 * the one command to run when a PC is not reporting. */
export const STATUS_COMMAND = "python -m meterhouse status";

/** Stops a locally running agent (the scheduled task relaunches it within
 * about a minute unless it has also been removed). */
export const STOP_COMMAND = "python -m meterhouse stop";

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
    `# 2 — Connect this PC: register + scan + sync + start + supervise, one command`,
    connectCommand(opts.server, opts.apiKey, opts.displayName),
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
 * Run the agent in the foreground to watch it work — useful for diagnosing a
 * PC that is not reporting. It scans continuously until you close the window
 * or stop it; the scheduled task (`REGISTER_SUPERVISOR_COMMAND`) is what keeps
 * it running unattended afterward.
 */
export const DAEMON_COMMAND = "python -m meterhouse daemon";
