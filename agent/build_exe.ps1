# Build a standalone claudefleet.exe (no Python/pip/git needed to run it).
#
# Usage:
#   cd agent
#   .\build_exe.ps1
#
# Output: agent\dist\claudefleet.exe

$ErrorActionPreference = "Stop"

$py = if (Get-Command py -ErrorAction SilentlyContinue) { @("py", "-3") } else { @("python") }

Write-Host "Installing build dependencies..."
& $py[0] $py[1..($py.Length-1)] -m pip install --quiet --upgrade pip pyinstaller

Write-Host "Building claudefleet.exe..."
& $py[0] $py[1..($py.Length-1)] -m PyInstaller `
    --onefile --name claudefleet --console --clean `
    --distpath dist --workpath build --specpath . `
    entry.py

Write-Host ""
Write-Host "Built: agent\dist\claudefleet.exe" -ForegroundColor Green
& .\dist\claudefleet.exe --version
