<#
    打包 plugins\official 下的全部插件（每个含 plugin.json 的子目录一个 zip）。

    用法：
        powershell -File plugins\build-plugins.ps1
        powershell -File plugins\build-plugins.ps1 -OutDir dist\plugins

    与 examples\plugins\build-examples.ps1 相同：使用随项目内置的 7-Zip，
    产物默认写到 dist\plugins\（已被 .gitignore 忽略）。
#>
param(
    [string]$OutDir = "dist\plugins",
    [string]$SourceDir = "plugins\official"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$source = Join-Path $root $SourceDir
if (-not (Test-Path $source)) { throw "找不到插件源目录：$source" }

$sevenZip = Join-Path $root "third_party\7zip\7za.exe"
if (-not (Test-Path $sevenZip)) {
    $candidate = "C:\Program Files\7-Zip\7z.exe"
    if (Test-Path $candidate) { $sevenZip = $candidate } else { throw "找不到 7-Zip" }
}

$outPath = Join-Path $root $OutDir
New-Item -ItemType Directory -Force -Path $outPath | Out-Null

$plugins = Get-ChildItem $source -Directory | Where-Object { Test-Path (Join-Path $_.FullName "plugin.json") }
if (-not $plugins) {
    Write-Host "plugins\official 下还没有插件（预留目录）" -ForegroundColor Yellow
    exit 0
}

foreach ($plugin in $plugins) {
    $manifest = Get-Content (Join-Path $plugin.FullName "plugin.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $target = Join-Path $outPath ("{0}-{1}.zip" -f $manifest.id, $manifest.version)
    if (Test-Path $target) { Remove-Item -LiteralPath $target -Force }
    Push-Location $plugin.FullName
    try { & $sevenZip a -tzip $target "." -y -bso0 -bsp0 | Out-Null } finally { Pop-Location }
    Write-Host ("packed {0}  ->  {1}" -f $manifest.name, $target) -ForegroundColor Green
}
