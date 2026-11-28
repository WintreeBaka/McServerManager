# Assembles the portable Windows release from an already deployed build.
#
# Prerequisites: run scripts\build-windows.ps1 -Deploy first, so that
# build\bin contains the executables plus the Qt runtime.
#
# Usage:
#     .\tools\package-release.ps1
#     .\tools\package-release.ps1 -Flavor with-plugins             # 追加示例插件包
#     .\tools\package-release.ps1 -Flavor with-container-porter    # 附带官方插件「容器搬运工」
#     .\tools\package-release.ps1 -Version 1.2.4 -DistDir dist
#
# Flavours deliberately get different folder names:
#     McServerManager-<版本>-win64                        含 GUI 的便携版
#     McServerManager-<版本>-win64-with-plugins          附加 plugin-packages\*.zip
#     McServerManager-<版本>-win64-with-container-porter 附带容器搬运工插件包
#     McServerManager-<版本>-cli-win64                    纯 CLI 精简版（无 Qt Widgets/Qml）
param(
    [string]$BinDir = "build\bin",
    [string]$DistDir = "dist",
    [string]$Version = "",
    [ValidateSet("plain", "with-plugins", "with-container-porter", "cli")]
    [string]$Flavor = "plain",
    [string]$QtBin = "",
    [string]$MinGwBin = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "script-common.ps1")
if (-not $Version) { $Version = Get-ProjectVersion -ProjectRoot $projectRoot }
if (-not $QtBin -or -not $MinGwBin) {
    $qtKit = if ($QtBin) { Split-Path -Parent $QtBin } else { Find-QtKit -ProjectRoot $projectRoot }
    $runtime = Resolve-QtRuntime -QtKit $qtKit
    if (-not $QtBin) { $QtBin = $runtime.Bin }
    if (-not $MinGwBin) { $MinGwBin = $runtime.MinGwBin }
}

& (Join-Path $PSScriptRoot "verify-third-party.ps1")

if (-not (Test-Path (Join-Path $BinDir "mcsm-cli.exe"))) {
    throw "missing $BinDir\mcsm-cli.exe - build the backend first"
}
if (-not (Test-Path (Join-Path $BinDir "Qt6Core.dll"))) {
    Write-Warning "Qt6Core.dll not found next to the exe: run build-windows.ps1 -Deploy for a self-contained package"
}

$suffix = if ($Flavor -eq "with-plugins") { "-with-plugins" } elseif ($Flavor -eq "with-container-porter") { "-with-container-porter" } elseif ($Flavor -eq "cli") { "-cli" } else { "" }
$name = "McServerManager-$Version-win64$suffix"
$stage = Join-Path $DistDir $name
if (Test-Path $stage) { Remove-ManagedDirectory -Path $stage }
Set-ManagedMarker -Path $stage

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
foreach ($extra in @("README.md", $quickstart, "THIRD_PARTY_NOTICES.md", "LICENSE",
                     "third_party\LGPL-3.0.txt")) {
    if (Test-Path $extra) {
        Copy-Item $extra -Destination $stage -Force
    }
}

# docs (plugin SDK + API reference) travel with the release so the "接口文档"
# button inside the app works on a portable copy
if (Test-Path "docs") {
    Copy-Item "docs" -Destination $stage -Recurse -Force
}
if ($Flavor -ne "cli" -and (Test-Path "assets\icon\app.svg")) {
    $iconTarget = Join-Path $stage "assets\icon"
    New-Item -ItemType Directory -Force -Path $iconTarget | Out-Null
    Copy-Item "assets\icon\app.svg" -Destination $iconTarget -Force
    if (Test-Path "assets\icon\app.ico") {
        Copy-Item "assets\icon\app.ico" -Destination $iconTarget -Force
    }
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
foreach ($notice in @("SHA256SUMS.txt", "readme.txt", "history.txt")) {
    $source = Join-Path "third_party\7zip" $notice
    if (Test-Path $source) {
        Copy-Item $source -Destination (Join-Path $stage "7zip") -Force
    }
}

# "with-plugins" flavour: ship the ready to import example plugin packages so a
# tester can load them from 设置 → 插件扩展 → 添加插件 (they are NOT pre-installed;
# the app data directory is %LOCALAPPDATA%\McServerManager).
if ($Flavor -eq "with-plugins") {
    # Distinguish API v2 examples from official packages, which may also be
    # present in dist\plugins. Rebuild examples on every packaging pass so a
    # stale official-package directory cannot be shipped under the wrong label.
    $pluginDir = Join-Path $DistDir "example-plugins"
    & (Join-Path $PSScriptRoot "..\examples\plugins\build-examples.ps1") -OutDir $pluginDir | Out-Null
    $target = Join-Path $stage "plugin-packages"
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item (Join-Path $pluginDir "*.zip") -Destination $target -Force
    $packages = (Get-ChildItem $target -Filter *.zip).Count
    Write-Host ("bundled {0} example plugin package(s)" -f $packages) -ForegroundColor Cyan
}

# "with-container-porter" flavour: ship both official 容器搬运工 plugin packages —— the
# full edition (UI page) and the CLI-only edition (backend scope). A fresh copy can move a
# server container right away via 设置 → 插件扩展 → 添加插件, or via mcsm-cli.
if ($Flavor -eq "with-container-porter") {
    $target = Join-Path $stage "plugin-packages"
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $variants = @(
        @{ Id = "com.mcsm.container-porter";     Dir = "plugins\official\container-porter" },
        @{ Id = "com.mcsm.container-porter.cli"; Dir = "plugins\official\container-porter-cli" }
    )
    $bundled = @()
    foreach ($variant in $variants) {
        $manifest = Join-Path $variant.Dir "plugin.json"
        $zip = $null
        if (Test-Path $manifest) {
            $version = (Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
            $zip = Get-Item (Join-Path $DistDir ("plugins\{0}-{1}.zip" -f $variant.Id, $version)) -ErrorAction SilentlyContinue
        }
        if (-not $zip) {
            $zip = Get-ChildItem (Join-Path $DistDir "plugins") -Filter ("{0}-*.zip" -f $variant.Id) -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
        }
        if (-not $zip) {
            throw ("missing {0}\plugins\{1}-*.zip - run plugins\build-plugins.ps1 first" -f $DistDir, $variant.Id)
        }
        Copy-Item $zip.FullName -Destination $target -Force
        Copy-Item (Join-Path $variant.Dir "README.md") -Destination ($target + "\" + $variant.Id + "-README.md") -Force -ErrorAction SilentlyContinue
        $bundled += $zip.Name
    }
    $note = @"
容器搬运工——两个版本，只需装一个：

* $($bundled[0])  完整版（全局作用域）：桌面管理器用，左侧导航会多出「导入与导出」页面。
* $($bundled[1])  CLI 版（只有后端）：只装了 mcsm-cli 的机器、服务器主机、脚本 / CI 用，没有界面。

两版后端是同一份代码，导出的 .tar 容器包可以互相导入。

安装：
  管理器里：设置 → 插件扩展 → 添加插件，选择上面的 zip。
  命令行：  mcsm-cli plugin package install --zip "$($bundled[0])"
            mcsm-cli plugin package install --zip "$($bundled[1])"
"@
    Set-Content -Path (Join-Path $target "安装说明.txt") -Value $note -Encoding UTF8
    Write-Host ("bundled {0}" -f ($bundled -join " + ")) -ForegroundColor Cyan
}

$total = (Get-ChildItem $stage -Recurse -File | Measure-Object -Property Length -Sum).Sum
$fileCount = (Get-ChildItem $stage -Recurse -File | Measure-Object).Count

$zipPath = Join-Path $DistDir "$name.zip"
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Write-Host "compressing..." -ForegroundColor Cyan
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal
$shaPath = "$zipPath.sha256"
$shaLine = "{0}  {1}" -f (Get-Sha256File -Path $zipPath), (Split-Path $zipPath -Leaf)
Set-Content -LiteralPath $shaPath -Value $shaLine -Encoding ASCII

$zipSize = (Get-Item $zipPath).Length
Write-Host ""
Write-Host "release ready:" -ForegroundColor Green
Write-Host ("  folder : {0}  ({1} files, {2:N1} MB)" -f $stage, $fileCount, ($total / 1MB))
Write-Host ("  zip    : {0}  ({1:N1} MB)" -f $zipPath, ($zipSize / 1MB))
Write-Host ("  sha256 : {0}" -f $shaPath)
Write-Host ""
Write-Host "contents:" -ForegroundColor DarkGray
Get-ChildItem $stage | Sort-Object Name | ForEach-Object {
    $type = if ($_.PSIsContainer) { "dir " } else { "file" }
    Write-Host ("  [{0}] {1}" -f $type, $_.Name) -ForegroundColor DarkGray
}
