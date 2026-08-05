/**
 * One-click PC connect.
 *
 * Before: an admin created a system, created a key, copied it, and the user then
 * ran three CLI commands by hand — six steps, terminal required, admin-only.
 *
 * Now: the user clicks "Connect this PC" and copies a single line. That line
 * fetches a generated PowerShell script which installs the agent, registers it,
 * runs the first scan and sync, and schedules scan+sync every 15 minutes. After
 * that the dashboard updates itself.
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
    "# 5 - keep it updating on its own. Pick ONE:",
    "",
    "#   (a) Background, survives closing this window and reboots. Runs one",
    "#       scan+sync cycle every 15 minutes. `once` is a single command on",
    "#       purpose: chaining scan && sync inside a task action needs nested",
    "#       quoting that frequently registers a task which never actually runs.",
    "$py = (Get-Command python).Source",
    "$pyw = Join-Path (Split-Path $py) 'pythonw.exe'   # no console window",
    "$exe = if (Test-Path $pyw) { $pyw } else { $py }",
    "$act = New-ScheduledTaskAction -Execute $exe -Argument '-m meterhouse once --quiet'",
    "$trg = New-ScheduledTaskTrigger -Once -At (Get-Date) " +
      "-RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)",
    "Register-ScheduledTask -TaskName 'Meterhouse Scan+Sync' -Action $act -Trigger $trg -Force",
    "",
    "#   (b) The daemon - scans every 60s and holds the real-time connection.",
    "#       Started like this it dies with the window; the one-line installer",
    "#       registers it as a scheduled task instead, which is what survives.",
    "#       Useful here for watching the log output while diagnosing something:",
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
# Installs the agent (pip), connects this PC, and registers two scheduled tasks
# so reporting continues after this window is closed and after a reboot:
#   - the daemon (scans every 60s, holds the real-time connection), started at
#     logon and re-checked every 5 minutes in case it stopped;
#   - a plain scan+sync every 15 minutes as a fallback.
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
$daemonArgs = $pyPrefix + @('-m', 'meterhouse', 'daemon')
$onceArgs   = $pyPrefix + @('-m', 'meterhouse', 'once', '--quiet')

# --- 6. register the background tasks ----------------------------------------
# Two tasks, on purpose:
#
#   Meterhouse Agent      the daemon. Started at logon AND re-checked every 5
#                         minutes, so a daemon that was killed (antivirus, a
#                         crash, sleep/resume) is back within minutes instead of
#                         waiting for the next logon. Relaunching while one is
#                         already running is harmless - the daemon takes a
#                         single-instance lock and a duplicate exits at once.
#
#   Meterhouse Scan+Sync  a plain scan+sync every 15 minutes. It is the safety
#                         net for machines where the daemon cannot stay alive:
#                         usage keeps arriving, and - because commands queued in
#                         the dashboard are collected on the same call - the
#                         admin's "Scan now" and config pushes still get through.
#
# Both run only while this user is logged on, which is all a per-user agent
# needs, and neither requires administrator rights to register.
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

# Old task names from previous installs - removed so an upgrade does not leave a
# second, differently-configured agent running alongside the new one.
foreach ($old in @('Meterhouse Daemon', 'Meterhouse Daemon Watchdog')) {
  schtasks /Delete /TN $old /F 2>&1 | Out-Null
}
Remove-Item (Join-Path $InstallDir 'watchdog.ps1') -ErrorAction SilentlyContinue

$tasksOk = $true
try {
  $logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"
  # A "once, then repeat forever" trigger. RepetitionDuration has to be a long
  # finite span; [TimeSpan]::MaxValue is rejected by the task scheduler.
  $every5 = New-ScheduledTaskTrigger -Once -At (Get-Date) \`
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  Register-MeterhouseTask -Name 'Meterhouse Agent' -Execute $daemonFile \`
    -Arguments $daemonArgs -Triggers @($logon, $every5)

  $every15 = New-ScheduledTaskTrigger -Once -At (Get-Date) \`
    -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
  Register-MeterhouseTask -Name 'Meterhouse Scan+Sync' -Execute $daemonFile \`
    -Arguments $onceArgs -Triggers @($every15)

  Write-Host 'Background tasks registered:'
  Write-Host '  - Meterhouse Agent      (starts at logon, re-checked every 5 minutes)'
  Write-Host '  - Meterhouse Scan+Sync  (every 15 minutes, fallback)'
} catch {
  $tasksOk = $false
  Write-Host ("Could not register the scheduled tasks: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
  Write-Host 'Falling back to schtasks...' -ForegroundColor Yellow
  # Fallback for machines where the ScheduledTasks module is unavailable. The
  # action is written to a .cmd file first so the /TR value is a single path
  # with no embedded quotes to mangle.
  $launcher = Join-Path $InstallDir 'agent.cmd'
  Set-Content -Path $launcher -Encoding ASCII -Value @(
    '@echo off',
    'start "" /B "' + $daemonFile + '" ' + ($daemonArgs -join ' ')
  )
  schtasks /Create /SC ONLOGON /TN 'Meterhouse Agent' /TR "\`"$launcher\`"" /RL LIMITED /F 2>&1 | Out-Null
  schtasks /Create /SC MINUTE /MO 5 /TN 'Meterhouse Agent Check' /TR "\`"$launcher\`"" /RL LIMITED /F 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $tasksOk = $true; Write-Host 'Registered via schtasks.' }
}

# --- 7. start it now and confirm it is actually alive -------------------------
Write-Host 'Starting the Meterhouse agent in the background...'
Start-Process -FilePath $daemonFile -ArgumentList $daemonArgs -WindowStyle Hidden

Write-Host 'Waiting for the agent to report in...'
Start-Sleep -Seconds 8
& $runner @('health')

$alive = $false
if (Test-Path $HealthFile) {
  try {
    $h = Get-Content $HealthFile -Raw | ConvertFrom-Json
    $age = ((Get-Date).ToUniversalTime() - [DateTime]::Parse($h.updated_at).ToUniversalTime()).TotalSeconds
    if ($age -lt 120) { $alive = $true }
  } catch {}
}

Write-Host ''
if ($alive) {
  Write-Host 'Done. The agent is running in the background.' -ForegroundColor Green
  Write-Host 'You can close this window - it keeps reporting after you close it, and restarts itself at logon.'
} else {
  Write-Host 'The agent was installed but did not report health within 8 seconds.' -ForegroundColor Yellow
  Write-Host 'Usage will still reach the dashboard via the 15-minute Scan+Sync task.'
  Write-Host 'To see what went wrong, run this and read the output:'
  Write-Host ('  {0} -m meterhouse daemon' -f $launchFile)
}
if (-not $tasksOk) {
  Write-Host 'No scheduled task could be registered - the agent will NOT restart after a reboot.' -ForegroundColor Yellow
}
Write-Host ("Open {0} to see this PC." -f $Server)
Write-Host ''
`;
}
