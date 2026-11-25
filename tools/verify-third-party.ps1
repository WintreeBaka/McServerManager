$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$toolDir = Join-Path $root "third_party\7zip"
$toolPath = Join-Path $toolDir "7za.exe"
$sumsPath = Join-Path $toolDir "SHA256SUMS.txt"

if (-not (Test-Path $toolPath)) { throw "missing bundled 7za.exe" }
if (-not (Test-Path $sumsPath)) { throw "missing third_party/7zip/SHA256SUMS.txt" }

$line = Get-Content $sumsPath -Encoding UTF8 |
    Where-Object { $_ -match '^([0-9a-fA-F]{64})\s+\*?7za\.exe\s*$' } |
    Select-Object -First 1
if (-not $line) { throw "SHA256SUMS.txt has no x64/7za.exe digest" }
$expected = ([regex]::Match($line, '^([0-9a-fA-F]{64})')).Groups[1].Value.ToLowerInvariant()
$actual = (Get-FileHash $toolPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
    throw "7za.exe SHA-256 mismatch: expected $expected, got $actual"
}

$bytes = [System.IO.File]::ReadAllBytes($toolPath)
$peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
$machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
if ($machine -ne 0x8664) {
    throw ("7za.exe is not x64 (PE machine 0x{0:X4})" -f $machine)
}

Write-Host ("verified 7za.exe  SHA256={0}" -f $actual) -ForegroundColor Green
