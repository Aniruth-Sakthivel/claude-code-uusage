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

$InstallDir = Join-Path $env:LOCALAPPDATA "Meterhouse"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$InstallLog = Join-Path $InstallDir "install.log"

function Invoke-Meterhouse {
    param([Parameter(Mandatory)][string[]]$Arguments)

    if (-not $Arguments -or $Arguments.Count -eq 0) {
        throw "Invoke-Meterhouse called with no subcommand - refusing to run 'meterhouse' with no arguments."
    }

    if ($exe) {
        $execute = $exe
        $baseArgs = @()
    } elseif (Get-Command meterhouse -ErrorAction SilentlyContinue) {
        $execute = (Get-Command meterhouse).Source
        $baseArgs = @()
    } else {
        $execute = $script:PyExe
        $baseArgs = @($script:PyArgs) + @("-m", "meterhouse")
    }
    $fullArgs = @($baseArgs) + $Arguments
    $commandLine = "$execute $($fullArgs -join ' ')"
    Write-Host "  > $commandLine"

    # stderr to a temp file, not `2>&1` merged into the success stream:
    # under $ErrorActionPreference = "Stop", `2>&1` turns each stderr line
    # into a terminating error the instant it's written, which would abort
    # the call before $LASTEXITCODE could be checked below.
    $stderrFile = [System.IO.Path]::GetTempFileName()
    try {
        $stdoutLines = & $execute @fullArgs 2>$stderrFile
        $exitCode = $LASTEXITCODE
        $stderrText = Get-Content -Path $stderrFile -Raw -ErrorAction SilentlyContinue
    } finally {
        Remove-Item -Path $stderrFile -ErrorAction SilentlyContinue
    }

    $logLine = "[{0}] RUN {1}" -f (Get-Date -Format "o"), $commandLine
    $logLine += "`n  cwd: {0}" -f (Get-Location)
    $logLine += "`n  exit: {0}" -f $exitCode
    $logLine += "`n  stdout: {0}" -f (($stdoutLines | Out-String).Trim())
    $logLine += "`n  stderr: {0}" -f (($stderrText | Out-String).Trim())
    Add-Content -Path $InstallLog -Value $logLine

    if ($exitCode -ne 0) {
        throw "meterhouse $($Arguments -join ' ') exited with code ${exitCode}: $stderrText"
    }
    return $stdoutLines
}

Write-Host "Registering with central server..."
Invoke-Meterhouse -Arguments @(
    "register", "--server", $Server.TrimEnd("/"), "--api-key", $ApiKey, "--display-name", $Name
)

# Folded into setup rather than left as a separate step, so this one command
# really does cover everything: usage, plus the account's identity (email,
# org, plan tier) and the rate-limit percentages Claude Code already caches.
# Prompts, responses, and source code are never read, here or anywhere else.
# Opt out any time, no reinstall needed: meterhouse account disable
Write-Host "Sharing Claude account + plan + rate-limit usage..."
Invoke-Meterhouse -Arguments @("account", "enable") | Out-Null

Write-Host "Running first scan..."
Invoke-Meterhouse -Arguments @("scan")

Write-Host "Syncing to dashboard..."
Invoke-Meterhouse -Arguments @("sync")

# The agent is always-on now: a single persistent `meterhouse daemon` process,
# scanning continuously, kept alive by the scheduled task registered below
# rather than by Claude Code session hooks (there are none anymore).
#
# Resolve how to launch it once - the exact same command is used both to
# start it right now and as the scheduled task's action.
if ($exe) {
    $daemonExecute = $exe
    $daemonArguments = "daemon"
} else {
    $pyPath = (Get-Command $script:PyExe).Source
    # pythonw/pyw run without a console, so neither the immediate launch nor
    # the scheduled task flashes a window in the user's face.
    $windowless = Join-Path (Split-Path $pyPath -Parent) $(if ($script:PyExe -eq "py") { "pyw.exe" } else { "pythonw.exe" })
    $daemonExecute = if (Test-Path $windowless) { $windowless } else { $pyPath }
    $prefix = if ($script:PyArgs.Count -gt 0) { ($script:PyArgs -join " ") + " " } else { "" }
    $daemonArguments = "${prefix}-m meterhouse daemon"
}

Write-Host "Starting the agent..."
# Fire-and-forget: `run_daemon` detaches and keeps running after this script
# (and this process) exits. Start-Process does not wait for it.
Start-Process -FilePath $daemonExecute -ArgumentList $daemonArguments -WindowStyle Hidden

if (-not $SkipSchedule) {
    $taskName = "Meterhouse Agent"

    # Whether this shell is elevated (Run as Administrator). Elevated ->
    # a machine-wide task running as SYSTEM (survives switching users,
    # works even if nobody is logged in). Not elevated -> a per-user task
    # registered with no explicit Principal at all, which is what every
    # standard account is already allowed to do - see the comment on
    # $taskPrincipal below for why an explicit one caused "Access is denied".
    $isElevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    # Removed rather than left disabled: an upgraded machine running both an
    # old hook-driven install and the new supervisor would double up.
    #
    # Piped through cmd /c rather than PowerShell's own `2>$null`: schtasks
    # writes its "task not found" error straight to the console output
    # buffer instead of through the process's redirectable stdout/stderr
    # streams, so PowerShell-level redirection cannot suppress it. cmd.exe
    # redirection happens at the OS handle level before schtasks ever gets
    # a console to write to directly, so `>nul 2>nul` actually works here.
    foreach ($old in @("Meterhouse Scan+Sync", "Meterhouse Daily Catch-up")) {
        cmd /c "schtasks /Delete /TN `"$old`" /F >nul 2>nul"
    }

    try {
        $action = New-ScheduledTaskAction -Execute $daemonExecute -Argument $daemonArguments
        # Two triggers: logon starts it promptly on a fresh session; the
        # 1-minute repeat (Task Scheduler's minimum granularity) is the
        # self-healing floor if it ever dies. Every trigger firing while a
        # daemon is already running exits in milliseconds - see
        # `run_daemon`'s single-instance lock check - which is what makes a
        # 1-minute repeating trigger safe to register unconditionally rather
        # than fragile.
        $logonTrigger = New-ScheduledTaskTrigger -AtLogOn
        # No -RepetitionDuration: omitting it is what makes the repetition
        # indefinite. Passing [TimeSpan]::MaxValue used to be here instead -
        # it looks like the "forever" value, but Task Scheduler serializes
        # triggers as an ISO 8601 duration, and MaxValue overflows the
        # schema's representable range. The task still got created, but every
        # attempt to *run* the resulting XML failed validation with "The task
        # XML contains a value which is incorrectly formatted or out of
        # range" (its accompanying "Duration:P99999999DT23H59M59S" is the
        # schema's own max-duration constant, printed as part of that
        # rejection) - which is exactly why the agent stopped surviving
        # reboots. Leaving the parameter out entirely sidesteps the
        # conversion altogether.
        $repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
            -RepetitionInterval (New-TimeSpan -Minutes 1)
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

        # Constructing an explicit ScheduledTaskPrincipal (UserId + RunLevel)
        # on a non-elevated shell is what previously produced "Access is
        # denied" here, even with RunLevel set no higher than the token
        # already has - asking the registration API for an explicit
        # principal at all routes through a code path that needs elevation;
        # it is not about which RunLevel value was requested. Elevated
        # sessions get a real SYSTEM principal (machine-wide, no login
        # required); everyone else gets no -Principal at all, which lets
        # Register-ScheduledTask default to this process's own token - the
        # one path standard accounts are always permitted to use.
        if ($isElevated) {
            $taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
            Register-ScheduledTask -TaskName $taskName -Action $action `
                -Trigger @($logonTrigger, $repeatTrigger) -Settings $settings -Principal $taskPrincipal -Force -ErrorAction Stop | Out-Null
        } else {
            Register-ScheduledTask -TaskName $taskName -Action $action `
                -Trigger @($logonTrigger, $repeatTrigger) -Settings $settings -Force -ErrorAction Stop | Out-Null
        }

        # Validate immediately rather than trusting a non-throwing return -
        # Register-ScheduledTask has been seen to report success while the
        # task manager silently rejects the definition on some Windows
        # builds. Get-ScheduledTask re-reads the task straight from the
        # scheduler, so this is the same check `meterhouse status` would want
        # to make from the outside.
        $registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
        if ($registered.State -eq "Disabled") {
            throw "Task '$taskName' registered but is Disabled - Task Scheduler will not run it."
        }
        $scopeLabel = if ($isElevated) { "machine-wide (SYSTEM)" } else { "per-user" }
        Write-Host "Scheduled task '$taskName' registered and verified (scope: $scopeLabel, state: $($registered.State)) - relaunches the agent within about a minute if it ever stops."
    } catch {
        $hresult = "0x{0:X8}" -f $_.Exception.HResult
        Write-Host "Could not register the scheduled task ($hresult): $($_.Exception.Message)"
        Write-Host "The agent is running now, but will not survive a reboot or crash without it."
        if (-not $isElevated) {
            Write-Host "Re-run this installer from an elevated ('Run as Administrator') PowerShell for a machine-wide task, or diagnose with:"
        } else {
            Write-Host "Diagnose with:"
        }
        Write-Host "  schtasks /Query /TN `"Meterhouse Agent`" /V"
    }
}

Write-Host ""
Write-Host "Done. The agent is running continuously and does not depend on Claude Code sessions."
Write-Host ""
Write-Host "Claude account + plan + rate-limit usage is shared too - turn it off any time:"
Write-Host "  meterhouse account disable"
Write-Host "To stop the agent locally:  meterhouse stop"
Write-Host "Open your dashboard to see usage for '$Name'."
