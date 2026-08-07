/**
 * One-click PC connect.
 *
 * Before: an admin created a system, created a key, copied it, and the user then
 * ran three CLI commands by hand — six steps, terminal required, admin-only.
 *
 * Now: the user clicks "Connect this PC" and copies a single line. That line
 * fetches a generated PowerShell script which installs the agent, registers it,
 * runs the first scan and sync, and starts it as a persistent background
 * process — no Claude Code session hooks, scanning continuously regardless of
 * whether Claude Code is open. After that the dashboard updates itself.
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

/**
 * The one-line command a user pastes to install the agent.
 *
 * Deliberately not a bare `irm URL | iex`. That pipes Invoke-RestMethod's
 * result straight into Invoke-Expression with zero validation, and on at
 * least one real machine the result arrived split into a line array instead
 * of one string — cause not pinned down (repeated, careful reproduction
 * attempts against the identical server, script, and PowerShell version all
 * came back clean, so whatever mangled it was environmental: a security
 * product doing HTTP inspection, an antivirus proxy, a flaky loopback read).
 * Piping an array into `iex` invokes it once per element: most are blank
 * lines, each throwing "Cannot bind argument to parameter 'Command' because
 * it is an empty string", and any multi-line construct in the script fails
 * with "Missing closing '}'" because only its opening line ran. Capturing
 * into a variable first makes the array case detectable and — since the
 * bytes themselves were fine, only their shape was wrong — trivially
 * repairable by rejoining before executing. A null/empty result (a
 * genuinely failed fetch) gets a plain error instead of that same cryptic
 * parameter-binding message.
 *
 * Every `$` below is backtick-escaped. This whole string is one argument to
 * an OUTER powershell.exe, wrapped in double quotes — and double-quoted
 * strings interpolate variables even when the string is just being built to
 * hand to a subprocess. Pasted at a PowerShell prompt (the officially
 * supported target — cmd.exe gets an explicit warning to avoid it), an
 * unescaped `$s` is a variable reference in the OUTER shell's own scope,
 * where it is unset — so it silently becomes an empty string before the
 * nested `-Command` ever runs, and `iex` receives literally nothing. Caught
 * by actually running the generated command, not by inspection: the first,
 * unescaped version of this failed with "'=' is not recognized" on the very
 * first try. `installCommand.test.ts` locks the escaping down so a future
 * edit that adds a variable without backtick-escaping it fails loudly
 * instead of silently reintroducing exactly this.
 */
export function buildInstallCommand(scriptUrl: string): string {
  return (
    `powershell -NoProfile -ExecutionPolicy Bypass -Command ` +
    "\"`$s = irm '" + scriptUrl + "'; " +
    "if (`$s -is [array]) { `$s = `$s -join [Environment]::NewLine }; " +
    "if ([string]::IsNullOrWhiteSpace(`$s)) { " +
    "Write-Host 'Could not fetch the setup script - try again, or open the link in a browser.' -ForegroundColor Red " +
    '} else { iex `$s }"'
  );
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
  const scriptUrl = `${base}/api/v1/connect/script/${token}`;
  return {
    systemId: result.systemId,
    displayName: result.displayName,
    installCommand: buildInstallCommand(scriptUrl),
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
  const connectArgs = [
    "python -m meterhouse connect",
    `--server ${pwshQuote(server)}`,
    `--api-key ${pwshQuote(apiKey)}`,
    `--display-name ${pwshQuote(displayName)}`,
    "--account",
  ];
  if (wsUrl) connectArgs.push(`--ws-url ${pwshQuote(wsUrl)}`);

  return [
    "# Run these in PowerShell. (In cmd.exe the single quotes below are NOT",
    "# stripped by the shell and end up inside the values - if you must use",
    "# cmd.exe, remove every ' character first.)",
    "",
    "# 1 - install the agent (once per PC)",
    "python -m pip install --upgrade meterhouse-rotor",
    "",
    "# 2 - connect this PC: registers, runs the first scan + sync, shares",
    "#     Claude account + plan + rate-limit usage (--account), starts the",
    "#     agent, and (on Windows) registers the scheduled task that keeps it",
    "#     running across reboots and self-heals if it ever dies. One command,",
    "#     nothing else to run afterward.",
    connectArgs.join(" "),
    "",
    "# Check whether it's running, and what it last reported:",
    "python -m meterhouse status",
    "",
    "# Optional: if you would rather type 'meterhouse' than 'python -m meterhouse',",
    "# add the user Scripts folder to PATH once, then open a new terminal:",
    "#   $s = python -c \"import site,os;print(os.path.join(site.USER_BASE,'Scripts'))\"",
    "#   [Environment]::SetEnvironmentVariable('Path', \"$env:Path;$s\", 'User')",
    "",
    "# --- Uninstalling this PC ---",
    "# Stop the running agent and remove whichever scheduled tasks exist (older",
    "# names included). Errors are harmless.",
    "python -m meterhouse stop",
    'schtasks /Delete /TN "Meterhouse Agent" /F',
    'schtasks /Delete /TN "Meterhouse Daily Catch-up" /F',
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
# One command does everything: installs the agent (pip), connects this PC,
# shares Claude account + plan + rate-limit usage, sends the first scan, and
# starts the agent as a persistent background process that keeps reporting
# after this window is closed and after a reboot - it scans continuously
# (every 5s by default), independent of whether Claude Code is open, and a
# scheduled task relaunches it within about a minute if it ever stops.
# Nothing else to run afterward. Closing this window is expected and safe.

$ErrorActionPreference = 'Stop'

$Server      = ${q(server)}
$ApiKey      = ${q(apiKey)}
$DisplayName = ${q(displayName)}
$RepoUrl     = ${q(repoUrl)}
$WsUrl       = ${q(wsUrl ?? "")}
$InstallDir  = Join-Path $env:LOCALAPPDATA 'Meterhouse'
$HealthFile  = Join-Path $env:USERPROFILE '.claude\\meterhouse\\health.json'
$InstallLog  = Join-Path $InstallDir 'install.log'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Whether this shell is running elevated (Run as Administrator). Determines
# whether the scheduled task below can be machine-wide (runs as SYSTEM,
# whether or not anyone is logged in) or must stay scoped to this user's own
# security context (which every standard account can already register tasks
# under, without any special privilege).
$IsElevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# Structured step logging: every step's name, outcome, duration, and (on
# failure) the exact exception are appended to $InstallLog as well as shown
# on screen, so a failed install can be diagnosed from the log alone instead
# of from whatever scrolled past in the terminal. \`\$Critical = \$false\` steps
# (the scheduled task, the final status check) log and report a failure but
# do not abort the rest of the install - losing crash-survival or a status
# print is not a reason to leave the agent half-installed.
function Write-InstallStep {
  param([string]$Step, [scriptblock]$Action, [bool]$Critical = $true)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    & $Action
    $sw.Stop()
    Add-Content -Path $InstallLog -Value ("[{0}] OK   {1} ({2}ms)" -f (Get-Date -Format 'o'), $Step, $sw.ElapsedMilliseconds)
    Write-Host ("  [OK]   {0}" -f $Step) -ForegroundColor Green
  } catch {
    $sw.Stop()
    $hresult = '0x{0:X8}' -f $_.Exception.HResult
    Add-Content -Path $InstallLog -Value ("[{0}] FAIL {1} ({2}ms) hresult={3} - {4}" -f (Get-Date -Format 'o'), $Step, $sw.ElapsedMilliseconds, $hresult, $_.Exception.Message)
    Write-Host ("  [FAIL] {0}: {1} ({2})" -f $Step, $_.Exception.Message, $hresult) -ForegroundColor Red
    if ($Critical) { throw }
  }
}

Write-Host ''
Write-Host '=== Meterhouse setup ===' -ForegroundColor Cyan
Write-Host ("  PC:        {0}" -f $DisplayName)
Write-Host ("  Server:    {0}" -f $Server)
Write-Host ("  Elevated:  {0}" -f $IsElevated)
Write-Host ("  Log:       {0}" -f $InstallLog)
Write-Host ''

# --- 1. find Python ----------------------------------------------------------
# Kept as a separate executable and argument list, never one array that gets
# indexed. \`$x = if (...) { @('python') }\` does NOT produce an array: PowerShell
# enumerates the single-element result through the statement's output pipeline
# and \`$x\` lands as the plain string 'python'. \`$x[0]\` is then the character
# 'p', and the install died with "The term 'p' is not recognized". The two-
# element \`@('py','-3')\` branch survived that, so the failure only ever showed
# on machines where python.exe was found first — i.e. most of them.
$pyExe = $null
$pyArgs = @()
foreach ($candidate in @('python', 'py')) {
  if (Get-Command $candidate -ErrorAction SilentlyContinue) {
    $pyExe = $candidate
    if ($candidate -eq 'py') { $pyArgs = @('-3') }
    break
  }
}
if (-not $pyExe) {
  Write-Host 'Python 3.10+ was not found on PATH.' -ForegroundColor Red
  Write-Host 'Install it from https://python.org (tick "Add python.exe to PATH"), then re-run this command.'
  exit 1
}

# --- 2. install the agent -----------------------------------------------------
# stdout is discarded to keep this quiet; stderr is left alone. \`2>&1\` on a
# native executable wraps every stderr line in a NativeCommandError, and with
# \`\$ErrorActionPreference = 'Stop'\` above that is a terminating error - so a
# perfectly harmless pip warning (e.g. a stale cache entry) killed the whole
# install before it ever reached pip's actual, checked exit code below.
Write-Host 'Installing the Meterhouse agent (pip)...'
& $pyExe @pyArgs -m pip install --upgrade pip --quiet | Out-Null
& $pyExe @pyArgs -m pip install --upgrade meterhouse-rotor --quiet | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'PyPI package unavailable - installing from source...'
  & $pyExe @pyArgs -m pip install "git+$RepoUrl#subdirectory=agent" --quiet
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Could not install the agent.' -ForegroundColor Red
    exit 1
  }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$cliCmd = Get-Command meterhouse -ErrorAction SilentlyContinue
if ($cliCmd) {
  $cliExecute = $cliCmd.Source
  $cliBaseArgs = @()
} else {
  $cliExecute = $pyExe
  $cliBaseArgs = @($pyArgs) + @('-m', 'meterhouse')
}

# A single, explicit call path instead of a scriptblock wrapper
# (\`\$runner = { param(\$FleetArgs) & meterhouse @FleetArgs }\`). That wrapper
# double-splats - once binding the caller's array to \$FleetArgs, again
# splatting \$FleetArgs into the actual invocation - and every call site had
# to remember to pass a non-empty array through both hops correctly. This
# script previously hit \`meterhouse\` running with zero arguments and
# printing its own top-level usage screen, which is exactly the failure mode
# a silently-empty \$FleetArgs produces: no subcommand means argparse's
# subparsers (\`required=True\`) reject it before anything else runs. Refusing
# to call with an empty argument list here, once, in the one place the
# command is actually built, is what makes that failure mode impossible
# instead of merely unlikely.
function Invoke-Meterhouse {
  param([Parameter(Mandatory)][string[]]$Arguments)

  if (-not $Arguments -or $Arguments.Count -eq 0) {
    throw "Invoke-Meterhouse called with no subcommand - refusing to run 'meterhouse' with no arguments."
  }

  $fullArgs = @($cliBaseArgs) + $Arguments
  $commandLine = "$cliExecute $($fullArgs -join ' ')"
  Write-Host "  > $commandLine"

  # stderr goes to a temp file, not \`2>&1\` merged into the output stream:
  # under \`\$ErrorActionPreference = 'Stop'\` (set above), \`2>&1\` turns every
  # stderr line into a terminating NativeCommandError at the point it's
  # written, which would abort the call before \$LASTEXITCODE could ever be
  # checked - the exact trap already documented on the pip install call
  # further up this script. File redirection carries no such risk.
  $stderrFile = [System.IO.Path]::GetTempFileName()
  try {
    $stdoutLines = & $cliExecute @fullArgs 2>$stderrFile
    $exitCode = $LASTEXITCODE
    $stderrText = (Get-Content -Path $stderrFile -Raw -ErrorAction SilentlyContinue)
  } finally {
    Remove-Item -Path $stderrFile -ErrorAction SilentlyContinue
  }

  if ($stdoutLines) { $stdoutLines | ForEach-Object { Write-Host $_ } }
  if ($stderrText) { Write-Host $stderrText -ForegroundColor DarkYellow }

  $logLine = "[{0}] RUN {1}" -f (Get-Date -Format 'o'), $commandLine
  $logLine += "\`n  cwd: {0}" -f (Get-Location)
  $logLine += "\`n  exit: {0}" -f $exitCode
  $logLine += "\`n  stdout: {0}" -f (($stdoutLines | Out-String).Trim())
  $logLine += "\`n  stderr: {0}" -f (($stderrText | Out-String).Trim())
  Add-Content -Path $InstallLog -Value $logLine

  if ($exitCode -ne 0) {
    throw "meterhouse $($Arguments -join ' ') exited with code $exitCode. $stderrText"
  }
  return $stdoutLines
}

# Resolved once, used both to launch the daemon immediately below and as the
# scheduled task's action - see step 6.
$pyCmd = Get-Command $pyExe -ErrorAction SilentlyContinue
$launchFile = if ($pyCmd) { $pyCmd.Source } else { $pyExe }
$pyDir = Split-Path $launchFile -Parent
$windowless = if ($pyExe -eq 'py') { Join-Path $pyDir 'pyw.exe' } else { Join-Path $pyDir 'pythonw.exe' }
$daemonFile = if (Test-Path $windowless) { $windowless } else { $launchFile }
$daemonArgs = $pyArgs + @('-m', 'meterhouse', 'daemon')

# --- 3. register this machine ------------------------------------------------
Write-Host 'Connecting this PC to the dashboard...'
$registerArgs = @('register', '--server', $Server, '--api-key', $ApiKey, '--display-name', $DisplayName)
if ($WsUrl) { $registerArgs += @('--ws-url', $WsUrl) }
Invoke-Meterhouse -Arguments $registerArgs

# --- 3b. share Claude account + plan + rate-limit usage ------------------------
# Folded into the one-line setup rather than left as a step to run later, so a
# connected PC needs no second command to appear on the Claude accounts page.
# What this adds beyond token counts: the account's identity (email, org, plan
# tier) and the rate-limit percentages Claude Code already caches locally.
# Prompts, responses, and source code are never read, on this path or any
# other, and OAuth tokens / credentials are never opened. Opt back out any
# time - it takes effect immediately, no reinstall - with:
#   meterhouse account disable
Write-Host 'Sharing Claude account + plan + rate-limit usage...'
Invoke-Meterhouse -Arguments @('account', 'enable') | Out-Null

# --- 4. first scan (immediate feedback; the daemon takes over from here) -----
Write-Host 'Scanning Claude Code transcripts (this may take a moment)...'
Invoke-Meterhouse -Arguments @('scan')
Write-Host 'Sending usage to the dashboard...'
Invoke-Meterhouse -Arguments @('sync')

# --- 5. start the agent -------------------------------------------------------
# A console process launched from this window is attached to this window's
# console: closing the terminal sends it CTRL_CLOSE_EVENT and Windows kills
# it, which is why usage used to stop flowing the moment someone closed the
# shell they pasted the installer into. pythonw.exe (pyw.exe for the
# launcher) is the GUI-subsystem interpreter - it gets no console at all, so
# there is nothing to close and nothing to signal it. Fire-and-forget: this
# process keeps running after this script (and this window) exits.
Write-Host 'Starting the agent...'
Start-Process -FilePath $daemonFile -ArgumentList ($daemonArgs -join ' ') -WindowStyle Hidden

# --- 6. keep it running across reboots and self-heal if it ever dies ---------
# Two triggers: logon starts it promptly on a fresh session; the 1-minute
# repeat (Task Scheduler's minimum granularity) is the self-healing floor if
# it ever dies. Every trigger firing while a daemon is already running exits
# in milliseconds - the agent's own single-instance lock check - which is
# what makes a 1-minute repeating trigger safe to register unconditionally
# rather than fragile. Scheduled tasks are given the executable and its
# arguments as separate values, never a single command string, so quoting
# hazards from a Python path containing spaces disappear with it.
#
# Principal is elevation-dependent, not a fixed "Interactive/Limited" pair as
# before. That fixed pair is what produced "Access is denied" on a plain,
# non-elevated shell: explicitly constructing a ScheduledTaskPrincipal with a
# -UserId and -RunLevel (even "Limited", which matches the token's own level)
# routes registration through a code path that needs the
# SeCreateGlobalPrivilege/"log on as a batch job" rights an elevated session
# has and a standard one does not - the RunLevel you ask for does not have to
# exceed what you already have for this to fail; asking for it *explicitly at
# all*, on this API, does. A standard user registering a task for themselves
# without specifying a Principal hits the implicit "current context" path
# instead, which every account is already permitted to use - this is the
# actual mechanism the per-account fallback below relies on, not a workaround.
function Register-MeterhouseTask {
  param([string]$Name, [string]$Execute, [string[]]$Arguments, [object[]]$Triggers, [object]$Principal)

  $action = New-ScheduledTaskAction -Execute $Execute -Argument ($Arguments -join ' ')
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries \`
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  if ($Principal) {
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Triggers \`
      -Settings $settings -Principal $Principal -Force -ErrorAction Stop | Out-Null
  } else {
    # No -Principal at all: registers under this process's own token, the
    # one registration path standard (non-admin) accounts are always allowed.
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Triggers \`
      -Settings $settings -Force -ErrorAction Stop | Out-Null
  }
}

# Task names from previous installs (hook-driven daily catch-up, or older
# always-on attempts). Leaving any behind would run the agent more often than
# this design intends, or duplicate the supervisor registered below.
#
# Routed through cmd /c "... >nul 2>nul", not PowerShell's own 2>$null or
# | Out-Null. schtasks.exe writes "ERROR: The system cannot find the file
# specified." straight to the inherited console handle for every task that
# simply never existed - the normal case on a fresh machine - rather than
# through its redirectable stdout/stderr streams, so neither
# \`| Out-Null\` (which only silences the success/object stream) nor
# PowerShell-level \`2>\` redirection catches it; five legacy names here means
# five of these printed on every fresh install. cmd.exe's redirection happens
# at the OS handle level before schtasks ever gets a console to write to
# directly, which is what actually suppresses it - confirmed by running the
# generated script, not by inspection (this is the same fix already applied
# in deploy/install.ps1's equivalent loop).
foreach ($old in @('Meterhouse Daily Catch-up', 'Meterhouse Agent Check', 'Meterhouse Scan+Sync',
                   'Meterhouse Daemon', 'Meterhouse Daemon Watchdog')) {
  cmd /c "schtasks /Delete /TN \`"$old\`" /F >nul 2>nul"
}
Remove-Item (Join-Path $InstallDir 'watchdog.ps1') -ErrorAction SilentlyContinue

$tasksOk = $true
Write-InstallStep -Critical $false -Step 'Register scheduled task' -Action {
  $logon = New-ScheduledTaskTrigger -AtLogOn
  # No -RepetitionDuration: that omission is what makes the repeat
  # indefinite. [TimeSpan]::MaxValue used to be passed here to mean
  # "forever", but Task Scheduler serializes triggers as an ISO 8601
  # duration and MaxValue overflows what the schema can represent - the task
  # registered without error but then failed to *run*, with "The task XML
  # contains a value which is incorrectly formatted or out of range". That
  # silent-until-runtime failure is exactly why the agent stopped surviving
  # reboots on machines that hit it. Leaving the parameter out sidesteps the
  # conversion entirely.
  $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)

  if ($IsElevated) {
    # Machine-wide: runs as SYSTEM whether or not this user is logged in,
    # and survives switching users entirely. Only valid with admin rights,
    # which this branch already has.
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  } else {
    # No Principal at all - see Register-MeterhouseTask's docstring above
    # for why passing one here is what caused "Access is denied" on a
    # standard account. This registers under the current user's own token,
    # the one path every account is already permitted to use.
    $taskPrincipal = $null
  }

  Register-MeterhouseTask -Name 'Meterhouse Agent' -Execute $daemonFile \`
    -Arguments $daemonArgs -Triggers @($logon, $repeat) -Principal $taskPrincipal

  # Re-read the task from the scheduler rather than trusting a non-throwing
  # return - Register-ScheduledTask has been seen to report success on a
  # definition Task Scheduler then silently rejects.
  $registered = Get-ScheduledTask -TaskName 'Meterhouse Agent' -ErrorAction Stop
  if ($registered.State -eq 'Disabled') {
    throw "Task registered but is Disabled - Task Scheduler will not run it."
  }
  Write-Host ("    scope: {0}, state: {1}" -f $(if ($IsElevated) { 'machine-wide (SYSTEM)' } else { 'per-user' }), $registered.State)
}
$tasksOk = (Get-ScheduledTask -TaskName 'Meterhouse Agent' -ErrorAction SilentlyContinue) -ne $null
if (-not $tasksOk) {
  Write-Host 'The agent is running now, but will not survive a reboot or crash without the scheduled task.' -ForegroundColor Yellow
  Write-Host ("See {0} for the exact error (including the Windows error code)." -f $InstallLog) -ForegroundColor Yellow
}

# --- 7. confirm it's actually running -----------------------------------------
# 'status' is a newer subcommand - a machine that installed from a stale
# cached wheel (pip resolving to an already-downloaded, older version) could
# still be running an agent build that predates it, with 'health' as the
# newest command it does have. Invoke-Meterhouse turns that nonzero exit into
# a real, catchable exception (it checks $LASTEXITCODE itself and throws) -
# a bare try/catch around the old direct \`& $runner @('status')\` call could
# not do this, because a native command's nonzero exit is not a terminating
# PowerShell error on its own; that gap is exactly why the raw argparse
# "invalid choice" text used to print straight through here regardless.
try {
  Invoke-Meterhouse -Arguments @('status') | Out-Null
} catch {
  Write-Host "'meterhouse status' is not available on this install (older agent version) - falling back to 'health'." -ForegroundColor Yellow
  try {
    Invoke-Meterhouse -Arguments @('health') | Out-Null
  } catch {
    Write-Host "Could not confirm the agent is running. Re-run:" -ForegroundColor Yellow
    Write-Host '  python -m pip install --upgrade --force-reinstall meterhouse-rotor' -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host 'Done. The agent is running continuously and does not depend on Claude Code sessions.' -ForegroundColor Green
Write-Host 'You can close this window.'
Write-Host ''
Write-Host 'Claude account + plan + rate-limit usage is shared too - turn it off any time with:'
Write-Host ('  {0} -m meterhouse account disable' -f $launchFile)
if (-not $tasksOk) {
  Write-Host 'No scheduled task could be registered - the agent will not restart after a reboot or crash.' -ForegroundColor Yellow
}
Write-Host ("Open {0} to see this PC." -f $Server)
Write-Host ''
`;
}
