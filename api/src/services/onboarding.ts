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
import { DEVELOPER, type Principal } from "../core/rbac.js";
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

function publicBaseUrl(requestOrigin?: string): string {
  const configured = config.PUBLIC_URL?.replace(/\/$/, "");
  if (configured) return configured;
  if (requestOrigin) return requestOrigin.replace(/\/$/, "");
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

    // Developers only see systems explicitly assigned to them (visibleSystemIds
    // is restrictive for that role, unlike admin/manager/viewer) — without
    // this, a developer connecting their own PC wouldn't see it afterward.
    if (actor.role === DEVELOPER) {
      await repo.addUserSystem(actor.id, systemId, tx);
    }

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
  const registerArgs = [
    "meterhouse register",
    `--server ${pwshQuote(server)}`,
    `--api-key ${pwshQuote(apiKey)}`,
    `--display-name ${pwshQuote(displayName)}`,
  ];
  if (wsUrl) registerArgs.push(`--ws-url ${pwshQuote(wsUrl)}`);

  return [
    "# 1 - install the agent (once per PC)",
    "pip install meterhouse-rotor",
    "",
    "# If 'meterhouse' is not recognized afterwards, pip installed it outside PATH.",
    "# Add the printed Scripts folder to PATH, or call it by full path, e.g.:",
    "#   $env:Path += ';C:\\Users\\<you>\\AppData\\Roaming\\Python\\Python3XX\\Scripts'",
    "#   [Environment]::SetEnvironmentVariable('Path', $env:Path, 'User')",
    "# then open a new terminal.",
    "",
    "# 2 - connect this PC (once)",
    registerArgs.join(" "),
    "",
    "# 3 - scan local transcripts and send to the dashboard",
    "meterhouse scan",
    "meterhouse sync",
    "",
    "# 4 - run continuously in the background (scans every 60s)",
    "meterhouse daemon",
    "",
    "# --- Uninstalling this PC ---",
    "# Stop the daemon and remove its scheduled tasks (if the one-line installer set them up):",
    'schtasks /Delete /TN "Meterhouse Daemon" /F',
    'schtasks /Delete /TN "Meterhouse Daemon Watchdog" /F',
    "# Remove the agent package and its local data (never touches ~/.claude/projects):",
    "pip uninstall meterhouse-rotor -y",
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
# This script installs the agent (pip), connects this PC, and starts a
# persistent daemon: scans every 60s (configurable) and, if enabled, streams
# status over a WebSocket. A watchdog task checks every minute that the
# daemon is alive and restarts it if not.

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

# --- 5. resolve a single launch target for the daemon + watchdog -------------
# Start-Process needs one concrete FilePath, not the "py -3" two-token form,
# so the interpreter is resolved to its actual executable.
$pyCmd = Get-Command $py[0] -ErrorAction SilentlyContinue
$launchFile = if ($pyCmd) { $pyCmd.Source } else { $py[0] }
$launchArgs = if ($py.Count -gt 1) { $py[1..($py.Length-1)] + @('-m', 'meterhouse', 'daemon') } else { @('-m', 'meterhouse', 'daemon') }

# --- 6. start the daemon now, and at every logon going forward ---------------
Write-Host 'Starting the Meterhouse daemon (scans every 60s in the background)...'
Start-Process -FilePath $launchFile -ArgumentList $launchArgs -WindowStyle Hidden

Write-Host 'Waiting briefly for the agent to start...'
Start-Sleep -Seconds 5
Write-Host 'Checking local agent health:'
& $runner @('health')

$daemonTask = 'Meterhouse Daemon'
$daemonAction = '"' + $launchFile + '" ' + ($launchArgs -join ' ')
schtasks /Delete /TN $daemonTask /F 2>&1 | Out-Null
schtasks /Create /SC ONLOGON /TN $daemonTask /TR $daemonAction /RL LIMITED /F 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host 'Scheduled the daemon to start automatically at logon.'
} else {
  Write-Host 'Could not schedule the logon task (the daemon is still running now).' -ForegroundColor Yellow
}

# --- 7. watchdog: if the daemon dies, restart it within a minute -------------
# A standalone .ps1 (not an inline schtasks /TR command) so the quoting stays
# simple and easy to inspect/debug independently. Built from single-quoted
# literal lines (no interpolation, no escaping) with only the few dynamic
# values spliced in via string concatenation - deliberately avoiding
# PowerShell's backtick escape character inside this generated JS template,
# since a stray backtick here would terminate the JS string early.
$watchdogPath = Join-Path $InstallDir 'watchdog.ps1'
$watchdogArgsLiteral = ($launchArgs -join "','")
$watchdogLines = @(
  '$ErrorActionPreference = ''SilentlyContinue''',
  '$stale = $true',
  'if (Test-Path ''' + $HealthFile + ''') {',
  '  try {',
  '    $h = Get-Content ''' + $HealthFile + ''' -Raw | ConvertFrom-Json',
  '    $updated = [DateTime]::Parse($h.updated_at).ToUniversalTime()',
  '    if (((Get-Date).ToUniversalTime() - $updated).TotalSeconds -lt 180) { $stale = $false }',
  '  } catch {}',
  '}',
  'if ($stale) {',
  '  Start-Process -FilePath ''' + $launchFile + ''' -ArgumentList @(''' + $watchdogArgsLiteral + ''') -WindowStyle Hidden',
  '}'
)
Set-Content -Path $watchdogPath -Value $watchdogLines -Encoding UTF8

$watchdogTask = 'Meterhouse Daemon Watchdog'
$watchdogAction = 'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $watchdogPath + '"'
schtasks /Delete /TN $watchdogTask /F 2>&1 | Out-Null
schtasks /Create /SC MINUTE /MO 1 /TN $watchdogTask /TR $watchdogAction /RL LIMITED /F 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host 'Watchdog active: checks every minute and restarts the daemon if it stops.'
} else {
  Write-Host 'Could not schedule the watchdog task.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Done. This PC now reports to your Meterhouse dashboard.' -ForegroundColor Green
Write-Host 'Run "meterhouse health" on this PC anytime to verify the local agent status.'
Write-Host ("Open {0} to see it." -f $Server)
Write-Host ''
`;
}
