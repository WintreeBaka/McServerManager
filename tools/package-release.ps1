# Assembles the portable Windows release from an already deployed build.
#
# Prerequisites: run scripts\build-windows.ps1 -Deploy first, so that
# build\bin contains the executables plus the Qt runtime.
#
# Usage:
#     .\tools\package-release.ps1
#     .\tools\package-release.ps1 -Flavor with-plugins             # 追加示例插件包
#     .\tools\package-release.ps1 -Flavor with-container-porter    # 附带官方插件「容器搬运工」
#     .\tools\package-release.ps1 -Version 1.2.0 -DistDir dist
#
# Flavours deliberately get different folder names:
#     McServerManager-<版本>-win64                        含 GUI 的便携版
#     McServerManager-<版本>-win64-with-plugins          附加 plugin-packages\*.zip
#     McServerManager-<版本>-win64-with-container-porter 附带容器搬运工插件包
#     McServerManager-<版本>-cli-win64                    纯 CLI 精简版（无 Qt Widgets/Qml）
param(
    [string]$BinDir = "build\bin",
    [string]$DistDir = "dist",
    [string]$Version = "1.2.0",
    [ValidateSet("plain", "with-plugins", "with-container-porter", "cli")]
    [string]$Flavor = "plain",
    [string]$QtBin = "D:\qt\6.11.2\mingw_64\bin",
    [string]$MinGwBin = "D:\qt\Tools\mingw1310_64\bin"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $BinDir "mcsm-cli.exe"))) {
    throw "missing $BinDir\mcsm-cli.exe - build the backend first"
}
if (-not (Test-Path (Join-Path $BinDir "Qt6Core.dll"))) {
    Write-Warning "Qt6Core.dll not found next to the exe: run build-windows.ps1 -Deploy for a self-contained package"
}

$suffix = if ($Flavor -eq "with-plugins") { "-with-plugins" } elseif ($Flavor -eq "with-container-porter") { "-with-container-porter" } elseif ($Flavor -eq "cli") { "-cli" } else { "" }
$name = "McServerManager-$Version-win64$suffix"
$stage = Join-Path $DistDir $name
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

if ($Flavor -eq "cli") {
    # Slim build: only the CLI plus the Qt modules it actually links (Core/Network).
    Write-Host "deploying CLI-only runtime..." -ForegroundColor Cyan
    Copy-Item (Join-Path $BinDir "mcsm-cli.exe") -Destination $stage -Force
    $windeployqt = Join-Path $QtBin "windeployqt.exe"
    if (-not (Test-Path $windeployqt)) {
        throw "windeployqt not found: $windeployqt (pass -QtBin)"
    }
    & $windeployqt "--release" "--no-translations" "--no-system-d3d-compiler" `
                   "--no-opengl-sw" "--no-quick-import" (Join-Path $stage "mcsm-cli.exe")
    foreach ($dll in @("libstdc++-6.dll", "libgcc_s_seh-1.dll", "libwinpthread-1.dll")) {
        $src = Join-Path $MinGwBin $dll
        if (Test-Path $src) { Copy-Item $src -Destination $stage -Force }
    }
} else {
    if (-not (Test-Path (Join-Path $BinDir "McServerManager.exe"))) {
        throw "missing $BinDir\McServerManager.exe - build with -Deploy first"
    }
    Write-Host "copying runtime..." -ForegroundColor Cyan
    Copy-Item (Join-Path $BinDir "*") -Destination $stage -Recurse -Force
}

$quickstart = if ($Flavor -eq "cli") { "packaging\QUICKSTART-CLI.txt" } else { "packaging\QUICKSTART.txt" }
foreach ($extra in @("README.md", $quickstart, "THIRD_PARTY_NOTICES.md", "LICENSE")) {
    if (Test-Path $extra) {
        Copy-Item $extra -Destination $stage -Force
    }
}

# docs (plugin SDK + API reference) travel with the release so the "接口文档"
# button inside the app works on a portable copy
if (Test-Path "docs") {
    Copy-Item "docs" -Destination $stage -Recurse -Force
}
if ($Flavor -ne "cli" -and (Test-Path "examples\plugins")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $stage "examples") | Out-Null
    Copy-Item "examples\plugins" -Destination (Join-Path $stage "examples") -Recurse -Force
}

# bundled 7-Zip: the backend unpacks plugin packages with it, so the target
# machine never needs 7-Zip installed. Archive::toolPath() looks for
# <exeDir>/7zip/7za.exe first.
$sevenZip = "third_party\7zip\7za.exe"
if (-not (Test-Path $sevenZip)) {
    throw "missing $sevenZip - the plugin package manager needs the bundled 7-Zip"
}
New-Item -ItemType Directory -Force -Path (Join-Path $stage "7zip") | Out-Null
Copy-Item $sevenZip -Destination (Join-Path $stage "7zip") -Force
if (Test-Path "third_party\7zip\LICENSE-7zip.txt") {
    Copy-Item "third_party\7zip\LICENSE-7zip.txt" -Destination (Join-Path $stage "7zip") -Force
}

# "with-plugins" flavour: ship the ready to import example plugin packages so a
# tester can load them from 设置 → 插件扩展 → 添加插件 (they are NOT pre-installed;
# the app data directory is %LOCALAPPDATA%\McServerManager).
if ($Flavor -eq "with-plugins") {
    $pluginDir = Join-Path $DistDir "plugins"
    if (-not (Get-ChildItem $pluginDir -Filter *.zip -ErrorAction SilentlyContinue)) {
        Write-Host "no packaged plugins found - running examples\plugins\build-examples.ps1" -ForegroundColor Yellow
        & (Join-Path $PSScriptRoot "..\examples\plugins\build-examples.ps1") | Out-Null
    }
    $target = Join-Path $stage "plugin-packages"
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item (Join-Path $pluginDir "*.zip") -Destination $target -Force
    $packages = (Get-ChildItem $target -Filter *.zip).Count
    Write-Host ("bundled {0} example plugin package(s)" -f $packages) -ForegroundColor Cyan
}

# "with-container-porter" flavour: ship the official 容器搬运工 plugin package so a
# fresh copy can move a server container right away (设置 → 插件扩展 → 添加插件).
if ($Flavor -eq "with-container-porter") {
    $pluginId = "com.mcsm.container-porter"
    $manifest = "plugins\official\container-porter\plugin.json"
    $pluginZip = $null
    if (Test-Path $manifest) {
        $version = (Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
        $pluginZip = Get-Item (Join-Path $DistDir "plugins\$pluginId-$version.zip") -ErrorAction SilentlyContinue
    }
    if (-not $pluginZip) {
        $pluginZip = Get-ChildItem (Join-Path $DistDir "plugins") -Filter "$pluginId-*.zip" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    if (-not $pluginZip) {
        throw "missing $DistDir\plugins\com.mcsm.container-porter-*.zip - run plugins\build-plugins.ps1 first"
    }
    $target = Join-Path $stage "plugin-packages"
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item $pluginZip.FullName -Destination $target -Force
    $note = "在管理器里打开 设置 → 插件扩展 → 添加插件，选择本目录的 {0}；`r`n也可以用命令行安装：mcsm-cli plugin package install --zip `"{0}`"。" -f $pluginZip.Name
    Set-Content -Path (Join-Path $target "安装说明.txt") -Value $note -Encoding UTF8
    Copy-Item "plugins\official\container-porter\README.md" -Destination $target -Force -ErrorAction SilentlyContinue
    Write-Host ("bundled {0}" -f $pluginZip.Name) -ForegroundColor Cyan
}

$total = (Get-ChildItem $stage -Recurse -File | Measure-Object -Property Length -Sum).Sum
$fileCount = (Get-ChildItem $stage -Recurse -File | Measure-Object).Count

$zipPath = Join-Path $DistDir "$name.zip"
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Write-Host "compressing..." -ForegroundColor Cyan
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal

$zipSize = (Get-Item $zipPath).Length
Write-Host ""
Write-Host "release ready:" -ForegroundColor Green
Write-Host ("  folder : {0}  ({1} files, {2:N1} MB)" -f $stage, $fileCount, ($total / 1MB))
Write-Host ("  zip    : {0}  ({1:N1} MB)" -f $zipPath, ($zipSize / 1MB))
Write-Host ""
Write-Host "contents:" -ForegroundColor DarkGray
Get-ChildItem $stage | Sort-Object Name | ForEach-Object {
    $type = if ($_.PSIsContainer) { "dir " } else { "file" }
    Write-Host ("  [{0}] {1}" -f $type, $_.Name) -ForegroundColor DarkGray
}
