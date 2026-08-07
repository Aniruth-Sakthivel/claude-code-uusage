# Build a standalone meterhouse.exe (no Python/pip/git needed to run it).
#
# Usage:
#   cd agent
#   .\build_exe.ps1
#
# Output: agent\dist\meterhouse.exe

$ErrorActionPreference = "Stop"

# Held apart as exe + args, not one array. `@("python")` collapses to the
# plain string "python" through PowerShell's output pipeline, making $py[0]
# the character "p" — see deploy/install.ps1 for the same bug and the full
# explanation.
if (Get-Command py -ErrorAction SilentlyContinue) { $pyExe = "py"; $pyArgs = @("-3") }
else { $pyExe = "python"; $pyArgs = @() }

Write-Host "Installing build dependencies..."
& $pyExe @pyArgs -m pip install --quiet --upgrade pip pyinstaller

Write-Host "Building meterhouse.exe..."
& $pyExe @pyArgs -m PyInstaller `
    --onefile --name meterhouse --console --clean `
    --distpath dist --workpath build --specpath . `
    entry.py

Write-Host ""
Write-Host "Built: agent\dist\meterhouse.exe" -ForegroundColor Green
& .\dist\meterhouse.exe --version
