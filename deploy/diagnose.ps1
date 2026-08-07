# Meterhouse diagnostic - run this on the machine that isn't scanning, and
# paste the full output back. Read-only: it changes nothing on the machine.

Write-Host "=== 1. What's actually installed ===" -ForegroundColor Cyan
python -m meterhouse --version
Write-Host "--- does this build have the always-on daemon? ---"
python -m meterhouse daemon --help 2>&1 | Select-Object -First 3
Write-Host "--- does this build have status/connect? ---"
python -m meterhouse status 2>&1 | Select-Object -First 3

Write-Host "`n=== 2. Is a daemon process alive right now? ===" -ForegroundColor Cyan
Get-Process pythonw, python, meterhouse -ErrorAction SilentlyContinue |
    Select-Object Id, ProcessName, StartTime, Path | Format-Table -AutoSize

Write-Host "`n=== 3. What does the scheduled task actually run? ===" -ForegroundColor Cyan
$task = Get-ScheduledTask -TaskName "Meterhouse Agent" -ErrorAction SilentlyContinue
if ($task) {
    $task | Select-Object TaskName, State
    $task.Actions | Select-Object Execute, Arguments | Format-List
    Get-ScheduledTaskInfo -TaskName "Meterhouse Agent" | Select-Object LastRunTime, LastTaskResult, NextRunTime
} else {
    Write-Host "No 'Meterhouse Agent' scheduled task found." -ForegroundColor Yellow
}

Write-Host "`n=== 4. Agent's own view of itself (health.json) ===" -ForegroundColor Cyan
$healthPath = "$env:USERPROFILE\.claude\meterhouse\health.json"
if (Test-Path $healthPath) {
    Get-Content $healthPath | ConvertFrom-Json | Format-List
} else {
    Write-Host "No health.json at $healthPath - the daemon has never written one." -ForegroundColor Yellow
}

Write-Host "`n=== 5. Last 40 lines of the agent's own log ===" -ForegroundColor Cyan
$logPath = "$env:USERPROFILE\.claude\meterhouse\agent.log"
if (Test-Path $logPath) {
    Get-Content $logPath -Tail 40
} else {
    Write-Host "No agent.log at $logPath." -ForegroundColor Yellow
}

Write-Host "`n=== 6. Did Windows Defender flag anything? ===" -ForegroundColor Cyan
try {
    $det = Get-MpThreatDetection -ErrorAction Stop | Where-Object { $_.Resources -match "Meterhouse|meterhouse|python" }
    if ($det) { $det | Format-List } else { Write-Host "No matching Defender detections." }
} catch {
    Write-Host "Could not query Defender (not present, or needs elevation): $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "`n=== 7. Is Claude Code actually producing transcripts to scan? ===" -ForegroundColor Cyan
$projDir = "$env:USERPROFILE\.claude\projects"
if (Test-Path $projDir) {
    Get-ChildItem $projDir -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 5 FullName, LastWriteTime, Length |
        Format-Table -AutoSize
} else {
    Write-Host "No $projDir directory - Claude Code hasn't been used on this machine yet." -ForegroundColor Yellow
}

Write-Host "`n=== 8. Install log, if the connect/installer flow was used ===" -ForegroundColor Cyan
$installLog = "$env:LOCALAPPDATA\Meterhouse\install.log"
if (Test-Path $installLog) {
    Get-Content $installLog -Tail 60
} else {
    Write-Host "No install.log at $installLog." -ForegroundColor Yellow
}
