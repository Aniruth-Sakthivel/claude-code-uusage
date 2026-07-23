# ClaudeFleet agent — one-command Windows setup
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

    [string]$RepoUrl = "https://github.com/YOUR-ORG/claude-code-uusage.git",

    [switch]$SkipSchedule
)

$ErrorActionPreference = "Stop"

function Find-Python {
    foreach ($cmd in @("python", "py")) {
        if (Get-Command $cmd -ErrorAction SilentlyContinue) {
            if ($cmd -eq "py") { return @("py", "-3") }
            return @($cmd)
        }
    }
    throw "Python 3.10+ not found. Install from https://python.org and ensure it is on PATH."
}

function Install-Agent {
    param([string[]]$Py)
    Write-Host "Installing ClaudeFleet agent..."
    & $Py -m pip install --upgrade pip --quiet
    & $Py -m pip install claudefleet-agent --quiet
    if ($LASTEXITCODE -eq 0) { return "claudefleet" }

    Write-Host "PyPI package not found — installing from git..."
    & $Py -m pip install "git+$RepoUrl#subdirectory=agent" --quiet
    if ($LASTEXITCODE -ne 0) { throw "Could not install agent. Publish to PyPI or set -RepoUrl." }
    return "claudefleet"
}

function Invoke-ClaudeFleet {
    param([string]$Exe, [string[]]$Args)
    if (Get-Command $Exe -ErrorAction SilentlyContinue) {
        & $Exe @Args
    } else {
        & python -m claudefleet @Args
    }
}

Write-Host "ClaudeFleet setup for '$Name' -> $Server"

$py = Find-Python
$agent = Install-Agent -Py $py

Write-Host "Registering with central server..."
Invoke-ClaudeFleet -Exe $agent -Args @(
    "register", "--server", $Server.TrimEnd("/"), "--api-key", $ApiKey, "--display-name", $Name
)

Write-Host "Running first scan..."
Invoke-ClaudeFleet -Exe $agent -Args @("scan")

Write-Host "Syncing to dashboard..."
Invoke-ClaudeFleet -Exe $agent -Args @("sync")

if (-not $SkipSchedule) {
    $taskName = "ClaudeFleet Scan+Sync"
    $pyExe = if ($py.Count -gt 1) { "py -3" } else { "python" }
    $action = "$pyExe -m claudefleet scan --quiet && $pyExe -m claudefleet sync --quiet"
    schtasks /Delete /TN $taskName /F 2>$null | Out-Null
    schtasks /Create /SC MINUTE /MO 15 /TN $taskName /TR $action /ST 00:00 /F | Out-Null
    Write-Host "Scheduled task '$taskName' — scan + sync every 15 minutes."
}

Write-Host ""
Write-Host "Done. Open your dashboard to see usage for '$Name'."
