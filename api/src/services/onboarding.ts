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
import type { Principal } from "../core/rbac.js";
import * as repo from "../repositories/admin.js";
import { allowsSystem, type Allowed } from "../repositories/scope.js";

/** Enrollment tokens are deliberately short-lived. */
const TOKEN_TTL_MS = 15 * 60 * 1000;

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

    return { systemId, displayName };
  });

  const base = publicBaseUrl(requestOrigin);
  return {
    systemId: result.systemId,
    displayName: result.displayName,
    installCommand: `irm ${base}/api/v1/connect/script/${token} | iex`,
    manualCommands: manualSetupBlock(base, fullKey, result.displayName),
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
    exeUrl: config.agentExeUrl,
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

function manualSetupBlock(server: string, apiKey: string, displayName: string): string {
  return [
    "# 1 - install the agent (once per PC)",
    "pip install claudefleet-agent",
    "",
    "# 2 - connect this PC (once)",
    `claudefleet register --server ${server} --api-key ${apiKey} --display-name ${displayName}`,
    "",
    "# 3 - scan local transcripts and send to the dashboard",
    "claudefleet scan",
    "claudefleet sync",
  ].join("\n");
}

/**
 * Generate the PowerShell installer.
 *
 * Mirrors deploy/install.ps1, but with the server URL, key, and machine name
 * already filled in so nothing has to be pasted by hand.
 *
 * Primary path: download the standalone claudefleet.exe (built by
 * .github/workflows/release-agent.yml, ~10MB, no Python/pip/git required) to
 * %LOCALAPPDATA%\ClaudeFleet\claudefleet.exe and run it directly — this is
 * what makes "paste one line" actually work on a clean Windows PC. Falls back
 * to the old pip/git path only if no release has been published yet or the
 * download fails, so this keeps working during the transition.
 */
export function renderInstallScript(opts: {
  server: string;
  apiKey: string;
  displayName: string;
  repoUrl: string;
  exeUrl: string;
}): string {
  const { server, apiKey, displayName, repoUrl, exeUrl } = opts;
  // Single-quoted PowerShell literals; escape any embedded quote.
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

  return `# ClaudeFleet agent setup - generated for ${displayName}
# This script installs the agent, connects this PC, runs a first scan,
# and schedules scan+sync every 15 minutes.

$ErrorActionPreference = 'Stop'

$Server      = ${q(server)}
$ApiKey      = ${q(apiKey)}
$DisplayName = ${q(displayName)}
$RepoUrl     = ${q(repoUrl)}
$ExeUrl      = ${q(exeUrl)}
$InstallDir  = Join-Path $env:LOCALAPPDATA 'ClaudeFleet'
$ExePath     = Join-Path $InstallDir 'claudefleet.exe'

Write-Host ''
Write-Host '=== ClaudeFleet setup ===' -ForegroundColor Cyan
Write-Host ("  PC:     {0}" -f $DisplayName)
Write-Host ("  Server: {0}" -f $Server)
Write-Host ''

# --- 1. get the agent --------------------------------------------------------
# Preferred: standalone exe, no Python/pip/git needed on this PC.
$exe = $null
Write-Host 'Downloading the ClaudeFleet agent...'
try {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Invoke-WebRequest -Uri $ExeUrl -OutFile $ExePath -UseBasicParsing
  & $ExePath --version | Out-Null
  if ($LASTEXITCODE -eq 0) { $exe = $ExePath }
} catch {
  Write-Host 'Standalone download unavailable - falling back to pip install...' -ForegroundColor Yellow
}

$py = $null
$runner = $null
if ($exe) {
  $runner = { param($FleetArgs) & $exe @FleetArgs }
} else {
  # Fallback: needs Python (and git for the source install) on PATH.
  foreach ($candidate in @('python', 'py')) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { $py = if ($candidate -eq 'py') { @('py', '-3') } else { @('python') }; break }
  }
  if (-not $py) {
    Write-Host 'Python 3.10+ was not found on PATH.' -ForegroundColor Red
    Write-Host 'Install it from https://python.org (tick "Add python.exe to PATH"), then re-run this command.'
    exit 1
  }

  Write-Host 'Installing the ClaudeFleet agent (pip)...'
  & $py[0] $py[1..($py.Length-1)] -m pip install --upgrade pip --quiet 2>&1 | Out-Null
  & $py[0] $py[1..($py.Length-1)] -m pip install claudefleet-agent --quiet 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'PyPI package unavailable - installing from source...'
    & $py[0] $py[1..($py.Length-1)] -m pip install "git+$RepoUrl#subdirectory=agent" --quiet
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'Could not install the agent.' -ForegroundColor Red
      exit 1
    }
  }

  $cliCmd = Get-Command claudefleet -ErrorAction SilentlyContinue
  if ($cliCmd) {
    $runner = { param($FleetArgs) & claudefleet @FleetArgs }
  } else {
    $runner = { param($FleetArgs) & $py[0] $py[1..($py.Length-1)] -m claudefleet @FleetArgs }
  }
}

# --- 2. register this machine ------------------------------------------------
Write-Host 'Connecting this PC to the dashboard...'
& $runner @('register', '--server', $Server, '--api-key', $ApiKey, '--display-name', $DisplayName)

# --- 3. first scan + sync -----------------------------------------------------
Write-Host 'Scanning Claude Code transcripts (this may take a moment)...'
& $runner @('scan')
Write-Host 'Sending usage to the dashboard...'
& $runner @('sync')

# --- 4. keep it up to date automatically --------------------------------------
$taskName = 'ClaudeFleet Scan+Sync'
if ($exe) {
  $action = '"' + $exe + '" scan --quiet & "' + $exe + '" sync --quiet'
} else {
  $pyExe  = if ($py.Count -gt 1) { 'py -3' } else { 'python' }
  $action = "$pyExe -m claudefleet scan --quiet & $pyExe -m claudefleet sync --quiet"
}
schtasks /Delete /TN $taskName /F 2>&1 | Out-Null
schtasks /Create /SC MINUTE /MO 15 /TN $taskName /TR "cmd /c $action" /ST 00:00 /F 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host 'Scheduled automatic scan + sync every 15 minutes.'
} else {
  Write-Host 'Could not create the scheduled task (usage was still sent).' -ForegroundColor Yellow
  Write-Host 'Run this in an elevated PowerShell to enable automatic updates.'
}

Write-Host ''
Write-Host 'Done. This PC now reports to your ClaudeFleet dashboard.' -ForegroundColor Green
Write-Host ("Open {0} to see it." -f $Server)
Write-Host ''
`;
}
