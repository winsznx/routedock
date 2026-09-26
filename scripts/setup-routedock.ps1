$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeBin = "$env:ProgramFiles\nodejs"
$gitBash = "$env:ProgramFiles\Git\bin\bash.exe"

if (-not (Test-Path $nodeBin)) {
    throw "Node.js was not found at $nodeBin"
}

if (-not (Test-Path $gitBash)) {
    throw "Git Bash was not found at $gitBash"
}

$env:PATH = "$nodeBin;$env:PATH"

Write-Host "Activating Corepack and pnpm..."
& "$nodeBin\corepack.cmd" enable
& "$nodeBin\corepack.cmd" prepare pnpm@9.15.9 --activate

Write-Host "Installing workspace dependencies..."
& "$nodeBin\corepack.cmd" pnpm install --frozen-lockfile --prefer-offline

Write-Host "Building local SDK dependencies..."
& "$nodeBin\corepack.cmd" pnpm --filter @routedock/nulth-sdk build
& "$nodeBin\corepack.cmd" pnpm --filter @routedock/routedock build

Write-Host "Running typecheck..."
& "$nodeBin\corepack.cmd" pnpm -r typecheck

Write-Host "Running SDK tests..."
$testFiles = Get-ChildItem (Join-Path $repoRoot 'packages/sdk/src') -Recurse -Include '*.test.ts', '*.test.tsx' | Sort-Object FullName | ForEach-Object { $_.FullName }
if ($testFiles.Count -eq 0) {
    throw "No SDK test files found under packages/sdk/src"
}
& "$nodeBin\corepack.cmd" pnpm --filter @routedock/routedock exec tsx --experimental-test-module-mocks --test $testFiles

Write-Host "Setup complete. The repo is ready for development."
