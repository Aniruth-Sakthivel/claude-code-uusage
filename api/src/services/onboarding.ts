/**
 * One-click PC connect.
 *
 * Before: an admin created a system, created a key, copied it, and the user then
 * ran three CLI commands by hand — six steps, terminal required, admin-only.
 *
 * Now: the user clicks "Connect this PC" and copies a single line. That line
 * fetches a generated PowerShell script which installs the agent, registers it,
 * runs the first scan and sync, and wires Claude Code's session hooks so the
 * agent starts and stops with the user's sessions. After that the dashboard
 * updates itself.
 *
 * Why a token instead of the key in the URL: the command is pasted into a
 * terminal and lands in shell history and possibly logs. The enrollment token is
 * single-use and expires in 15 minutes, so a leaked command is inert. The real
 * `cfk_` key is substituted server-side when the script is generated.
 *
 * Browser sandboxing prevents a web page from reading local files, so no button
 * can scan a PC directly. This is the closest achievable to one click.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";

import { config } from "../config.js";
import { db } from "../db/client.js";
import { apiKeys, enrollTokens, systems } from "../db/schema.js";
import { generateApiKey } from "../core/auth-agent.js";
import { forbidden, notFound } from "../core/errors.js";
import { type Principal } from "../core/rbac.js";
import * as repo from "../repositories/admin.js";
import { allowsSystem, type Allowed } from "../repositories/scope.js";

/** Enrollment tokens are deliberately short-lived. */
const TOKEN_TTL_MS = 15 * 60 * 1000;

/** Single-quoted PowerShell literal, with any embedded quote escaped.
 * Shared by both the generated installer and the manual copy-paste
 * commands — a display name containing spaces or shell metacharacters
 * must never produce a broken or unsafe line in either. */
function pwshQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export interface ConnectInput {
  display_name: string;
  system_id?: string | null;
  owner?: string;
  location?: string;
  environment?: string;
}

export interface ConnectResult {
  systemId: string;
  displayName: string;
  installCommand: string;
  manualCommands: string;
  apiKey: string;
  expiresAt: Date;
}

/**
 * Base URL to bake into enrollment commands and install scripts.
 *
 * The request origin wins over the configured `PUBLIC_URL`, because it is the
 * host the dashboard was *just* served from — reachable by construction. A
 * configured value can silently go stale (a renamed site, a leftover variable
 * in the host's UI) and there is no feedback loop: the command is copied onto
 * a PC, points at a host that no longer exists, and the agent fails forever
 * with no error visible in the dashboard. That is exactly what happened when
 * this deployment kept emitting `claude-code-usage.netlify.app` long after the
 * rename, so the safer default is to trust the origin actually in use.
 *
 * `PUBLIC_URL` remains the fallback for contexts with no request (CLI, tests,
 * scheduled jobs), and a mismatch is logged so misconfiguration stays visible
 * rather than silently overridden.
 */
function publicBaseUrl(requestOrigin?: string): string {
  const configured = config.PUBLIC_URL?.replace(/\/$/, "");
  const origin = requestOrigin?.replace(/\/$/, "");

  if (origin) {
    if (configured && configured !== origin) {
      console.warn(
        `[onboarding] PUBLIC_URL (${configured}) does not match the request ` +
          `origin (${origin}); using the request origin. Update PUBLIC_URL in ` +
          `the deployment environment to silence this.`,
      );
    }
    return origin;
  }

  if (configured) return configured;
  return `http://127.0.0.1:${config.PORT}`;
}

/**
 * Provision (or re-key) a system for the caller and mint an enrollment token.
 *
 * Available to every signed-in role, not just admins — this is what gives
 * developers and viewers a way to connect their own machine instead of landing
 * on an empty dashboard with no path forward.
 */
export async function connectPc(
  actor: Principal,
  allowed: Allowed,
  input: ConnectInput,
  requestOrigin?: string,
  ctx: { ip?: string; userAgent?: string } = {},
): Promise<ConnectResult> {
  const { fullKey, prefix, keyHash } = generateApiKey();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  const result = await db.transaction(async (tx) => {
    let systemId: string;
    let displayName: string;

    if (input.system_id) {
      // Re-keying an existing machine — the caller must be able to see it.
      if (!allowsSystem(allowed, input.system_id)) {
        throw forbidden("You do not have access to that system.");
      }
      const rows = await tx
        .select()
        .from(systems)
        .where(eq(systems.systemId, input.system_id))
        .limit(1);
      const existing = rows[0];
      if (!existing) throw notFound("System not found");

      systemId = existing.systemId;
      displayName = input.display_name || existing.displayName;
      if (displayName !== existing.displayName) {
        await tx
          .update(systems)
          .set({ displayName })
          .where(eq(systems.systemId, systemId));
      }
    } else {
      systemId = randomUUID();
      displayName = input.display_name;
      await tx.insert(systems).values({
        systemId,
        displayName,
        owner: input.owner ?? actor.email,
        location: input.location ?? "",
        environment: input.environment ?? "",
        createdByUserId: actor.id,
      });
    }

    const keyRows = await tx
      .insert(apiKeys)
      .values({ systemId, name: "enroll", prefix, keyHash })
      .returning({ id: apiKeys.id });

    await tx.insert(enrollTokens).values({
      token,
      systemId,
      apiKeyId: keyRows[0]!.id,
      apiKeyPlain: fullKey,
      createdByUserId: actor.id,
      displayName,
      expiresAt,
    });

    await repo.writeAudit(
      {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: input.system_id ? "system.rekeyed" : "system.connected",
        target: systemId,
        detail: `${displayName} (enroll token issued)`,
        ...ctx,
      },
      tx,
    );

    /**
     * Record who connected this machine, for every role.
     *
     * Two things depend on this link. Visibility: developers only see systems
     * explicitly assigned to them, so without it a developer connecting their
     * own PC could not see it afterward. Attribution: the People and Sessions
     * pages build their rows from `user_systems`, so a machine with no link
     * belongs to nobody and its activity appears under no one — which is why
     * an admin who connected their own PC saw those pages sit empty while the
     * Overview happily showed the same usage.
     *
     * Safe for the non-developer roles: `visibleSystemIds` returns null (all
     * systems) for admin/manager/viewer and never consults `user_systems`, so
     * adding a row grants attribution without narrowing anyone's access.
     * `addUserSystem` is idempotent, so re-keying an existing PC is a no-op.
     */
    await repo.addUserSystem(actor.id, systemId, tx);

    return { systemId, displayName };
  });

  const base = publicBaseUrl(requestOrigin);
  return {
    systemId: result.systemId,
    displayName: result.displayName,
    installCommand: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '${base}/api/v1/connect/script/${token}' | iex"`,
    manualCommands: manualSetupBlock(base, result.displayName, fullKey, config.PUBLIC_WS_URL),
    apiKey: fullKey,
    expiresAt,
  };
}

/**
 * Redeem an enrollment token and return the generated install script.
 *
 * Single-use: the token is marked consumed in the same transaction that reads
 * it, so a replayed URL gets nothing. Expired tokens are rejected and swept.
 */
export async function redeemEnrollToken(
  token: string,
  requestOrigin?: string,
): Promise<string> {
  const now = new Date();

  const redeemed = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(enrollTokens)
      .where(eq(enrollTokens.token, token))
      .limit(1);

    const row = rows[0];
    if (!row) throw notFound("Enrollment link not found.");
    if (row.usedAt) throw forbidden("This enrollment link has already been used.");
    if (row.expiresAt.getTime() < now.getTime()) {
      throw forbidden("This enrollment link has expired. Generate a new one.");
    }

    await tx
      .update(enrollTokens)
      .set({ usedAt: now })
      .where(eq(enrollTokens.token, token));

    await repo.writeAudit(
      {
        actorUserId: row.createdByUserId,
        actorEmail: "agent-enroll",
        action: "system.enroll_redeemed",
        target: row.systemId,
        detail: row.displayName,
      },
      tx,
    );

    return row;
  });

  return renderInstallScript({
    server: publicBaseUrl(requestOrigin),
    apiKey: redeemed.apiKeyPlain,
    displayName: redeemed.displayName,
    repoUrl: config.AGENT_REPO_URL,
    wsUrl: config.PUBLIC_WS_URL,
  });
}

/** Best-effort cleanup of expired/used tokens so plaintext keys don't linger. */
export async function sweepEnrollTokens(): Promise<void> {
  const cutoff = new Date(Date.now() - TOKEN_TTL_MS);
  await db
    .delete(enrollTokens)
    .where(
      or(
        lt(enrollTokens.expiresAt, cutoff),
        and(lt(enrollTokens.createdAt, cutoff), isNull(enrollTokens.usedAt)),
      ),
    );
}

/** Real values are baked directly into this block — server URL, API key, and
 * (when configured) the WebSocket URL for live status push — since it's only
 * ever shown once, to the authenticated user who just generated it. */
function manualSetupBlock(
  server: string,
  displayName: string,
  apiKey: string,
  wsUrl?: string,
): string {
  /**
   * Every command goes through `python -m meterhouse`, never the bare
   * `meterhouse` launcher.
   *
   * `pip install` drops console scripts into the *user* Scripts directory
   * (`%APPDATA%\Roaming\Python\PythonXY\Scripts`) whenever the system Python
   * directory isn't writable — which is the norm without admin rights. Windows
   * does not put that directory on PATH, so `meterhouse …` fails with "not
   * recognized" even though the install succeeded. `python -m` resolves the
   * module through the interpreter that is already on PATH, so it works in
   * cmd.exe and PowerShell alike with no PATH surgery. `pip` itself lives in
   * that same Scripts directory, so it gets the same treatment.
   */
  const registerArgs = [
    "python -m meterhouse register",
    `--server ${pwshQuote(server)}`,
    `--api-key ${pwshQuote(apiKey)}`,
    `--display-name ${pwshQuote(displayName)}`,
  ];
  if (wsUrl) registerArgs.push(`--ws-url ${pwshQuote(wsUrl)}`);

  return [
    "# Run these in PowerShell. (In cmd.exe the single quotes below are NOT",
    "# stripped by the shell and end up inside the values - if you must use",
    "# cmd.exe, remove every ' character first.)",
    "",
    "# 1 - install the agent (once per PC)",
    "python -m pip install --upgrade meterhouse-rotor",
    "",
    "# 2 - connect this PC (once)",
    registerArgs.join(" "),
    "",
    "# 3 - scan local transcripts and send to the dashboard",
    "python -m meterhouse scan",
    "python -m meterhouse sync",
    "",
    "# 4 - OPTIONAL: report Claude account + rate-limit usage to the",
    "#     dashboard's 'Claude accounts' page. Off by default. 'show' prints the",
    "#     exact payload first - credentials and OAuth tokens are never read.",
    "python -m meterhouse account show",
    "python -m meterhouse account enable",
    "python -m meterhouse sync          # the account report goes out with a sync",
    "",
    "# 5 - keep it updating on its own.",
    "",
    "#   (a) The normal way: let Claude Code start and stop the agent for you.",
    "#       This writes three hooks into ~/.claude/settings.json (your own",
    "#       hooks are preserved). The agent then runs only while a session is",
    "#       open - no background process at all on an idle PC, and nothing",
    "#       polling on a timer.",
    "python -m meterhouse install-hooks",
    "python -m meterhouse sessions      # what is live, and whether hooks are set",
    "",
    "#   (b) A daily catch-up, in case hook installation ever fails silently.",
    "#       `once` is a single command on purpose: chaining scan && sync inside",
    "#       a task action needs nested quoting that frequently registers a task",
    "#       which never actually runs.",
    "$py = (Get-Command python).Source",
    "$pyw = Join-Path (Split-Path $py) 'pythonw.exe'   # no console window",
    "$exe = if (Test-Path $pyw) { $pyw } else { $py }",
    "$act = New-ScheduledTaskAction -Execute $exe -Argument '-m meterhouse once --quiet'",
    "$trg = New-ScheduledTaskTrigger -Daily -At '12:30'",
    "Register-ScheduledTask -TaskName 'Meterhouse Daily Catch-up' -Action $act -Trigger $trg -Force",
    "",
    "#   (c) Run the agent by hand to watch what it does. It scans every 60s",
    "#       while a Claude Code session is open, then exits on its own.",
    "#       Add --always-on for a PC that cannot use hooks at all.",
    "python -m meterhouse daemon",
    "",
    "# Optional: if you would rather type 'meterhouse' than 'python -m meterhouse',",
    "# add the user Scripts folder to PATH once, then open a new terminal:",
    "#   $s = python -c \"import site,os;print(os.path.join(site.USER_BASE,'Scripts'))\"",
    "#   [Environment]::SetEnvironmentVariable('Path', \"$env:Path;$s\", 'User')",
    "",
    "# --- Uninstalling this PC ---",
    "# Remove whichever scheduled tasks exist (the last two are names used by",
    "# older installers). Errors are harmless.",
    "python -m meterhouse uninstall-hooks",
    'schtasks /Delete /TN "Meterhouse Daily Catch-up" /F',
    'schtasks /Delete /TN "Meterhouse Agent" /F',
    'schtasks /Delete /TN "Meterhouse Scan+Sync" /F',
    'schtasks /Delete /TN "Meterhouse Agent Check" /F',
    'schtasks /Delete /TN "Meterhouse Daemon" /F',
    'schtasks /Delete /TN "Meterhouse Daemon Watchdog" /F',
    "# Remove the agent package and its local data (never touches ~/.claude/projects):",
    "python -m pip uninstall meterhouse-rotor -y",
    'Remove-Item -Recurse -Force "$env:USERPROFILE\\.claude\\meterhouse" -ErrorAction SilentlyContinue',
    'Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\Meterhouse" -ErrorAction SilentlyContinue',
    "# Finally, remove this PC from the dashboard's Systems list so it stops appearing there.",
  ].join("\n");
}

/**
 * Generate the PowerShell installer.
 *
 * Mirrors deploy/install.ps1, but with the server URL, key, and machine name
 * already filled in so nothing has to be pasted by hand.
 *
 * Install path: `pip install meterhouse-rotor` (published to PyPI). Falls
 * back to installing straight from the GitHub repo only if the PyPI package
 * is ever unavailable. Requires Python 3.10+ on PATH — the standalone exe
 * path was dropped after repeatedly hitting antivirus/SmartScreen blocks on
 * clean Windows PCs, which made "paste one line" unreliable in practice.
 */
export function renderInstallScript(opts: {
  server: string;
  apiKey: string;
  displayName: string;
  repoUrl: string;
  wsUrl?: string;
}): string {
  const { server, apiKey, displayName, repoUrl, wsUrl } = opts;
  const q = pwshQuote;

  return `# Meterhouse agent setup - generated for ${displayName}
# Installs the agent (pip), connects this PC, and hands its lifecycle to Claude
# Code so reporting continues after this window is closed and after a reboot:
#   - session hooks start the agent when you open Claude Code and stop it when
#     you finish, so an idle PC runs no agent process at all;
#   - one daily catch-up scan+sync as a safety net.
# Closing this window is expected and safe.

$ErrorActionPreference = 'Stop'

$Server      = ${q(server)}
$ApiKey      = ${q(apiKey)}
$DisplayName = ${q(displayName)}
$RepoUrl     = ${q(repoUrl)}
$WsUrl       = ${q(wsUrl ?? "")}
$InstallDir  = Join-Path $env:LOCALAPPDATA 'Meterhouse'
$HealthFile  = Join-Path $env:USERPROFILE '.claude\\meterhouse\\health.json'

Write-Host ''
Write-Host '=== Meterhouse setup ===' -ForegroundColor Cyan
Write-Host ("  PC:     {0}" -f $DisplayName)
Write-Host ("  Server: {0}" -f $Server)
Write-Host ''

# --- 1. find Python ----------------------------------------------------------
$py = $null
foreach ($candidate in @('python', 'py')) {
  $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
  if ($cmd) { $py = if ($candidate -eq 'py') { @('py', '-3') } else { @('python') }; break }
}
if (-not $py) {
  Write-Host 'Python 3.10+ was not found on PATH.' -ForegroundColor Red
  Write-Host 'Install it from https://python.org (tick "Add python.exe to PATH"), then re-run this command.'
  exit 1
}

# --- 2. install the agent -----------------------------------------------------
Write-Host 'Installing the Meterhouse agent (pip)...'
& $py[0] $py[1..($py.Length-1)] -m pip install --upgrade pip --quiet 2>&1 | Out-Null
& $py[0] $py[1..($py.Length-1)] -m pip install --upgrade meterhouse-rotor --quiet 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'PyPI package unavailable - installing from source...'
  & $py[0] $py[1..($py.Length-1)] -m pip install "git+$RepoUrl#subdirectory=agent" --quiet
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Could not install the agent.' -ForegroundColor Red
    exit 1
  }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$cliCmd = Get-Command meterhouse -ErrorAction SilentlyContinue
if ($cliCmd) {
  $runner = { param($FleetArgs) & meterhouse @FleetArgs }
} else {
  $runner = { param($FleetArgs) & $py[0] $py[1..($py.Length-1)] -m meterhouse @FleetArgs }
}

# --- 3. register this machine ------------------------------------------------
Write-Host 'Connecting this PC to the dashboard...'
$registerArgs = @('register', '--server', $Server, '--api-key', $ApiKey, '--display-name', $DisplayName)
if ($WsUrl) { $registerArgs += @('--ws-url', $WsUrl) }
& $runner $registerArgs

# --- 4. first scan (immediate feedback; the daemon takes over from here) -----
Write-Host 'Scanning Claude Code transcripts (this may take a moment)...'
& $runner @('scan')
Write-Host 'Sending usage to the dashboard...'
& $runner @('sync')

# --- 5. resolve a windowless launch target ------------------------------------
# Two separate problems are being solved here.
#
# 1. A console process launched from this window is attached to this window's
#    console. Closing the terminal sends it CTRL_CLOSE_EVENT and Windows kills
#    it - which is exactly why usage stopped flowing the moment someone closed
#    the shell they pasted the installer into. pythonw.exe (pyw.exe for the
#    launcher) is the GUI-subsystem interpreter: it gets no console at all, so
#    there is no console to close and nothing to signal it.
#
# 2. Scheduled tasks are given the executable and its arguments as separate
#    values, never a single command string. Every quoting hazard that used to
#    break registration (a Python path containing spaces, the nested quotes in
#    a "cmd /c a && b" action) disappears with it.
$pyCmd = Get-Command $py[0] -ErrorAction SilentlyContinue
$launchFile = if ($pyCmd) { $pyCmd.Source } else { $py[0] }
$pyDir = Split-Path $launchFile -Parent
$windowless = if ($py[0] -eq 'py') { Join-Path $pyDir 'pyw.exe' } else { Join-Path $pyDir 'pythonw.exe' }
$daemonFile = if (Test-Path $windowless) { $windowless } else { $launchFile }
$pyPrefix = if ($py.Count -gt 1) { $py[1..($py.Length-1)] } else { @() }
$onceArgs   = $pyPrefix + @('-m', 'meterhouse', 'once', '--quiet')

# --- 6. hand the lifecycle to Claude Code ------------------------------------
# The agent is event-driven. Claude Code's own session hooks start it when
# someone begins working and stop it when the last session ends, so an idle PC
# runs no agent process at all - no logon task, no 5-minute supervisor, no
# 15-minute poll. Those three tasks existed only to answer "is anyone using
# Claude Code?", which the hooks answer directly.
#
# Crash recovery comes free with them: every prompt submitted re-checks that the
# agent is alive and restarts it if not, for that session only.
Write-Host 'Installing Claude Code session hooks...'
$hooksOk = $true
try {
  & $runner @('install-hooks')
  if ($LASTEXITCODE -ne 0) { $hooksOk = $false }
} catch { $hooksOk = $false }

# One task remains: a daily catch-up. It is the floor on data loss for a machine
# where hook installation failed or the agent was killed mid-session. Scanning
# is incremental and idempotent, so even a day behind it reports in full.
# It runs only while this user is logged on, which is all a per-user agent
# needs, and does not require administrator rights to register.
function Register-MeterhouseTask {
  param([string]$Name, [string]$Execute, [string[]]$Arguments, [object[]]$Triggers)

  $action = New-ScheduledTaskAction -Execute $Execute -Argument ($Arguments -join ' ')
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries \`
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" \`
    -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Triggers \`
    -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
}

# Task names from previous installs. These ran the agent around the clock and
# polled every 5 and 15 minutes; leaving any of them behind would keep doing
# exactly the work the hooks were installed to eliminate.
foreach ($old in @('Meterhouse Agent', 'Meterhouse Agent Check', 'Meterhouse Scan+Sync',
                   'Meterhouse Daemon', 'Meterhouse Daemon Watchdog')) {
  schtasks /Delete /TN $old /F 2>&1 | Out-Null
}
Remove-Item (Join-Path $InstallDir 'watchdog.ps1') -ErrorAction SilentlyContinue

$tasksOk = $true
try {
  $daily = New-ScheduledTaskTrigger -Daily -At '12:30'
  Register-MeterhouseTask -Name 'Meterhouse Daily Catch-up' -Execute $daemonFile \`
    -Arguments $onceArgs -Triggers @($daily)
  Write-Host 'Background task registered:'
  Write-Host '  - Meterhouse Daily Catch-up  (once a day, safety net only)'
} catch {
  $tasksOk = $false
  Write-Host ("Could not register the scheduled task: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
  Write-Host 'Falling back to schtasks...' -ForegroundColor Yellow
  # Fallback for machines where the ScheduledTasks module is unavailable. The
  # action is written to a .cmd file first so the /TR value is a single path
  # with no embedded quotes to mangle.
  $launcher = Join-Path $InstallDir 'catchup.cmd'
  Set-Content -Path $launcher -Encoding ASCII -Value @(
    '@echo off',
    'start "" /B "' + $daemonFile + '" ' + ($onceArgs -join ' ')
  )
  schtasks /Create /SC DAILY /ST 12:30 /TN 'Meterhouse Daily Catch-up' /TR "\`"$launcher\`"" /RL LIMITED /F 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $tasksOk = $true; Write-Host 'Registered via schtasks.' }
}

# --- 7. confirm the wiring, without starting anything -------------------------
# Nothing is launched here on purpose. There is no Claude Code session open
# right now, so a daemon started at this moment would correctly scan once and
# exit - and an installer that waits for a health file to appear would then
# report a false failure. What matters is whether the hooks are registered.
& $runner @('sessions')

Write-Host ''
if ($hooksOk) {
  Write-Host 'Done. The agent starts with your next Claude Code session.' -ForegroundColor Green
  Write-Host 'You can close this window. Nothing runs in the background until you use Claude Code,'
  Write-Host 'and it stops on its own when you finish.'
} else {
  Write-Host 'Usage was synced, but the Claude Code hooks could not be installed.' -ForegroundColor Yellow
  Write-Host 'The daily catch-up task will still report usage once a day.'
  Write-Host 'To retry, or to see why it failed, run:'
  Write-Host ('  {0} -m meterhouse install-hooks' -f $launchFile)
  Write-Host 'If this PC cannot use hooks at all, run the agent in always-on mode instead:'
  Write-Host ('  {0} -m meterhouse daemon --always-on' -f $launchFile)
}
if (-not $tasksOk) {
  Write-Host 'No scheduled task could be registered - there is no daily catch-up on this PC.' -ForegroundColor Yellow
}
Write-Host ("Open {0} to see this PC." -f $Server)
Write-Host ''
`;
}
