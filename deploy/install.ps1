# ClaudeFleet agent - one-command Windows setup
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
    [string]$ExeUrl = "https://github.com/Aniruth-Sakthivel/claude-code-uusage/releases/latest/download/claudefleet.exe",

    [switch]$SkipSchedule
)

$ErrorActionPreference = "Stop"

function Get-StandaloneExe {
    $installDir = Join-Path $env:LOCALAPPDATA "ClaudeFleet"
    $exePath = Join-Path $installDir "claudefleet.exe"
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
    Write-Host "Installing ClaudeFleet agent (pip)..."
    & $Py[0] $Py[1..($Py.Length-1)] -m pip install --upgrade pip --quiet
    & $Py[0] $Py[1..($Py.Length-1)] -m pip install claudefleet-agent --quiet
    if ($LASTEXITCODE -eq 0) { return }

    Write-Host "PyPI package not found - installing from git..."
    & $Py[0] $Py[1..($Py.Length-1)] -m pip install "git+$RepoUrl#subdirectory=agent" --quiet
    if ($LASTEXITCODE -ne 0) { throw "Could not install agent. Publish to PyPI or set -RepoUrl." }
}

Write-Host "ClaudeFleet setup for '$Name' -> $Server"

Write-Host "Fetching the agent..."
$exe = Get-StandaloneExe
$py = $null
if (-not $exe) {
    $py = Find-Python
    Install-AgentViaPip -Py $py
}

function Invoke-ClaudeFleet {
    param([string[]]$FleetArgs)
    if ($exe) {
        & $exe @FleetArgs
    } elseif (Get-Command claudefleet -ErrorAction SilentlyContinue) {
        & claudefleet @FleetArgs
    } else {
        & $py[0] $py[1..($py.Length-1)] -m claudefleet @FleetArgs
    }
}

Write-Host "Registering with central server..."
Invoke-ClaudeFleet -FleetArgs @(
    "register", "--server", $Server.TrimEnd("/"), "--api-key", $ApiKey, "--display-name", $Name
)

Write-Host "Running first scan..."
Invoke-ClaudeFleet -FleetArgs @("scan")

Write-Host "Syncing to dashboard..."
Invoke-ClaudeFleet -FleetArgs @("sync")

if (-not $SkipSchedule) {
    $taskName = "ClaudeFleet Scan+Sync"
    if ($exe) {
        $action = '"' + $exe + '" scan --quiet && "' + $exe + '" sync --quiet'
    } else {
        $pyExe = if ($py.Count -gt 1) { "py -3" } else { "python" }
        $action = "$pyExe -m claudefleet scan --quiet && $pyExe -m claudefleet sync --quiet"
    }
    schtasks /Delete /TN $taskName /F 2>$null | Out-Null
    schtasks /Create /SC MINUTE /MO 15 /TN $taskName /TR $action /ST 00:00 /F | Out-Null
    Write-Host "Scheduled task '$taskName' - scan + sync every 15 minutes."
}

Write-Host ""
Write-Host "Done. Open your dashboard to see usage for '$Name'."
