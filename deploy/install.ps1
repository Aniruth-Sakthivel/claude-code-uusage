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

function Find-Python {
    foreach ($cmd in @("python", "py")) {
        if (Get-Command $cmd -ErrorAction SilentlyContinue) {
            if ($cmd -eq "py") { return @("py", "-3") }
            return @($cmd)
        }
    }
    throw "Python 3.10+ not found. Install from https://python.org and ensure it is on PATH."
}

function Install-AgentViaPip {
    param([string[]]$Py)
    Write-Host "Installing Meterhouse agent (pip)..."
    & $Py[0] $Py[1..($Py.Length-1)] -m pip install --upgrade pip --quiet
    & $Py[0] $Py[1..($Py.Length-1)] -m pip install meterhouse-rotor --quiet
    if ($LASTEXITCODE -eq 0) { return }

    Write-Host "PyPI package not found - installing from git..."
    & $Py[0] $Py[1..($Py.Length-1)] -m pip install "git+$RepoUrl#subdirectory=agent" --quiet
    if ($LASTEXITCODE -ne 0) { throw "Could not install agent. Publish to PyPI or set -RepoUrl." }
}

Write-Host "Meterhouse setup for '$Name' -> $Server"

Write-Host "Fetching the agent..."
$exe = Get-StandaloneExe
$py = $null
if (-not $exe) {
    $py = Find-Python
    Install-AgentViaPip -Py $py
}

function Invoke-Meterhouse {
    param([string[]]$FleetArgs)
    if ($exe) {
        & $exe @FleetArgs
    } elseif (Get-Command meterhouse -ErrorAction SilentlyContinue) {
        & meterhouse @FleetArgs
    } else {
        & $py[0] $py[1..($py.Length-1)] -m meterhouse @FleetArgs
    }
}

Write-Host "Registering with central server..."
Invoke-Meterhouse -FleetArgs @(
    "register", "--server", $Server.TrimEnd("/"), "--api-key", $ApiKey, "--display-name", $Name
)

Write-Host "Running first scan..."
Invoke-Meterhouse -FleetArgs @("scan")

Write-Host "Syncing to dashboard..."
Invoke-Meterhouse -FleetArgs @("sync")

if (-not $SkipSchedule) {
    $taskName = "Meterhouse Scan+Sync"

    # `once` does scan + sync in a single process. The previous form chained
    # them with "&&", which has to be wrapped in cmd /c inside a task action;
    # the nested quoting that needs is a reliable way to register a task that
    # never actually runs, leaving a PC silently not reporting.
    if ($exe) {
        $execute = $exe
        $arguments = "once --quiet"
    } else {
        $pyPath = (Get-Command $py[0]).Source
        # pythonw/pyw run without a console, so the task does not flash a
        # window in the user's face every 15 minutes.
        $windowless = Join-Path (Split-Path $pyPath -Parent) $(if ($py[0] -eq "py") { "pyw.exe" } else { "pythonw.exe" })
        $execute = if (Test-Path $windowless) { $windowless } else { $pyPath }
        $prefix = if ($py.Count -gt 1) { ($py[1..($py.Length - 1)] -join " ") + " " } else { "" }
        $arguments = "$prefix-m meterhouse once --quiet"
    }

    try {
        $action = New-ScheduledTaskAction -Execute $execute -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
            -RepetitionInterval (New-TimeSpan -Minutes 15) `
            -RepetitionDuration (New-TimeSpan -Days 3650)
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
            -Settings $settings -Force -ErrorAction Stop | Out-Null
        Write-Host "Scheduled task '$taskName' - scan + sync every 15 minutes."
    } catch {
        Write-Host "Could not register the scheduled task: $($_.Exception.Message)"
        Write-Host "Usage already synced once; re-run this script or schedule 'meterhouse once' yourself."
    }
}

Write-Host ""
Write-Host "Done. Open your dashboard to see usage for '$Name'."
