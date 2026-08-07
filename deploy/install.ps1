# Meterhouse agent - one-command Windows setup
#
# Usage (replace values):
#   irm https://YOUR-SITE/install.ps1 | iex -Args "-Server https://YOUR-SITE -ApiKey cfk_... -Name PC-01"
#
# Or run locally:
#   .\install.ps1 -Server https://YOUR-SITE -ApiKey cfk_... -Name PC-01

param(
    [Parameter(Mandatory = $true)]
    [string]$Server,

    [Parameter(Mandatory = $true)]
    [string]$ApiKey,

    [Parameter(Mandatory = $true)]
    [string]$Name,

    [string]$RepoUrl = "https://github.com/Aniruth-Sakthivel/claude-code-uusage.git",

    # Standalone exe (no Python/pip/git needed) - published by
    # .github/workflows/release-agent.yml. Falls back to pip/git if this 404s.
    [string]$ExeUrl = "https://github.com/Aniruth-Sakthivel/claude-code-uusage/releases/latest/download/meterhouse.exe",

    [switch]$SkipSchedule
)

$ErrorActionPreference = "Stop"

function Get-StandaloneExe {
    $installDir = Join-Path $env:LOCALAPPDATA "Meterhouse"
    $exePath = Join-Path $installDir "meterhouse.exe"
    try {
        New-Item -ItemType Directory -Force -Path $installDir | Out-Null
        Invoke-WebRequest -Uri $ExeUrl -OutFile $exePath -UseBasicParsing
        & $exePath --version | Out-Null
        if ($LASTEXITCODE -eq 0) { return $exePath }
    } catch {
        Write-Host "Standalone exe unavailable - falling back to pip install..."
    }
    return $null
}

# The interpreter and its arguments are held apart, never as one array that
# later gets indexed. `return @("python")` does NOT hand back an array:
# PowerShell enumerates the single-element result through the function's output
# pipeline, so the caller receives the plain string "python". `$py[0]` is then
# the character "p" — which is exactly how this failed, with
# "The term 'p' is not recognized". The two-element @("py","-3") branch was
# unaffected, so the bug only bit machines that had python.exe on PATH.
$script:PyExe = $null
$script:PyArgs = @()

function Find-Python {
    foreach ($cmd in @("python", "py")) {
        if (Get-Command $cmd -ErrorAction SilentlyContinue) {
            $script:PyExe = $cmd
            # `py` is the launcher; -3 selects Python 3. `python` needs nothing.
            $script:PyArgs = if ($cmd -eq "py") { @("-3") } else { @() }
            return
        }
    }
    throw "Python 3.10+ not found. Install from https://python.org and ensure it is on PATH."
}

function Install-AgentViaPip {
    Write-Host "Installing Meterhouse agent (pip)..."
    & $script:PyExe @script:PyArgs -m pip install --upgrade pip --quiet
    & $script:PyExe @script:PyArgs -m pip install meterhouse-rotor --quiet
    if ($LASTEXITCODE -eq 0) { return }

    Write-Host "PyPI package not found - installing from git..."
    & $script:PyExe @script:PyArgs -m pip install "git+$RepoUrl#subdirectory=agent" --quiet
    if ($LASTEXITCODE -ne 0) { throw "Could not install agent. Publish to PyPI or set -RepoUrl." }
}

Write-Host "Meterhouse setup for '$Name' -> $Server"

Write-Host "Fetching the agent..."
$exe = Get-StandaloneExe
if (-not $exe) {
    Find-Python
    Install-AgentViaPip
}

function Invoke-Meterhouse {
    param([string[]]$FleetArgs)
    if ($exe) {
        & $exe @FleetArgs
    } elseif (Get-Command meterhouse -ErrorAction SilentlyContinue) {
        & meterhouse @FleetArgs
    } else {
        & $script:PyExe @script:PyArgs -m meterhouse @FleetArgs
    }
}

Write-Host "Registering with central server..."
Invoke-Meterhouse -FleetArgs @(
    "register", "--server", $Server.TrimEnd("/"), "--api-key", $ApiKey, "--display-name", $Name
)

# Folded into setup rather than left as a separate step, so this one command
# really does cover everything: usage, plus the account's identity (email,
# org, plan tier) and the rate-limit percentages Claude Code already caches.
# Prompts, responses, and source code are never read, here or anywhere else.
# Opt out any time, no reinstall needed: meterhouse account disable
Write-Host "Sharing Claude account + plan + rate-limit usage..."
Invoke-Meterhouse -FleetArgs @("account", "enable") | Out-Null

Write-Host "Running first scan..."
Invoke-Meterhouse -FleetArgs @("scan")

Write-Host "Syncing to dashboard..."
Invoke-Meterhouse -FleetArgs @("sync")

# The agent is event-driven: Claude Code's own session hooks start it when
# someone begins working and stop it when they finish. This is what makes an
# idle PC cost nothing at all - there is no agent process on it between
# sessions, and nothing polling on a timer.
Write-Host "Installing Claude Code session hooks..."
Invoke-Meterhouse -FleetArgs @("install-hooks")

if (-not $SkipSchedule) {
    $taskName = "Meterhouse Daily Catch-up"

    # The old task ran every 15 minutes - 96 wakeups a day on a machine that
    # might never open Claude Code. The hooks cover live reporting now, so this
    # is only a floor on data loss for a PC where hook installation failed or
    # the agent was killed. Scanning is incremental and idempotent, so a
    # machine a day behind still reports its complete history.
    foreach ($old in @("Meterhouse Scan+Sync", "Meterhouse Agent")) {
        # Removed rather than left disabled: an upgraded machine running both
        # the old 15-minute task and the new hooks would scan far more often
        # than either design intends.
        schtasks /Delete /TN $old /F 2>$null | Out-Null
    }

    # `once` does scan + sync in a single process. The previous form chained
    # them with "&&", which has to be wrapped in cmd /c inside a task action;
    # the nested quoting that needs is a reliable way to register a task that
    # never actually runs, leaving a PC silently not reporting.
    if ($exe) {
        $execute = $exe
        $arguments = "once --quiet"
    } else {
        $pyPath = (Get-Command $script:PyExe).Source
        # pythonw/pyw run without a console, so the task does not flash a
        # window in the user's face.
        $windowless = Join-Path (Split-Path $pyPath -Parent) $(if ($script:PyExe -eq "py") { "pyw.exe" } else { "pythonw.exe" })
        $execute = if (Test-Path $windowless) { $windowless } else { $pyPath }
        $prefix = if ($script:PyArgs.Count -gt 0) { ($script:PyArgs -join " ") + " " } else { "" }
        $arguments = "$prefix-m meterhouse once --quiet"
    }

    try {
        $action = New-ScheduledTaskAction -Execute $execute -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -Daily -At "12:30"
        # StartWhenAvailable matters more for a daily task than a 15-minute
        # one: a laptop asleep at the trigger time runs it on next wake rather
        # than skipping the day entirely.
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
            -Settings $settings -Force -ErrorAction Stop | Out-Null
        Write-Host "Scheduled task '$taskName' - a daily catch-up scan + sync."
    } catch {
        Write-Host "Could not register the scheduled task: $($_.Exception.Message)"
        Write-Host "Usage already synced once, and the session hooks still report live."
    }
}

Write-Host ""
Write-Host "Done. The agent now starts with your Claude Code sessions and stops when they end."
Write-Host ""
Write-Host "If Claude Code is open right now, fully quit and reopen it." -ForegroundColor Yellow
Write-Host "It reads hook config when a session starts, not while running - so a session already"
Write-Host "open when this ran (including one you pasted this command from) will not pick these up."
Write-Host ""
Write-Host "Claude account + plan + rate-limit usage is shared too - turn it off any time:"
Write-Host "  meterhouse account disable"
Write-Host "Open your dashboard to see usage for '$Name'."
