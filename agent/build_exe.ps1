# Build a standalone meterhouse.exe (no Python/pip/git needed to run it).
#
# Usage:
#   cd agent
#   .\build_exe.ps1
#
# Output: agent\dist\meterhouse.exe

$ErrorActionPreference = "Stop"

$py = if (Get-Command py -ErrorAction SilentlyContinue) { @("py", "-3") } else { @("python") }

Write-Host "Installing build dependencies..."
& $py[0] $py[1..($py.Length-1)] -m pip install --quiet --upgrade pip pyinstaller

Write-Host "Building meterhouse.exe..."
& $py[0] $py[1..($py.Length-1)] -m PyInstaller `
    --onefile --name meterhouse --console --clean `
    --distpath dist --workpath build --specpath . `
    entry.py

Write-Host ""
Write-Host "Built: agent\dist\meterhouse.exe" -ForegroundColor Green
& .\dist\meterhouse.exe --version
