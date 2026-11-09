<#
    创建 Gitea Release 并上传附件（与 create-release.ps1 对应）。

    需要一个 Gitea 访问令牌（设置 → 应用 → 生成令牌，至少 repository 读写）：

        $env:GITEA_TOKEN = "xxxxxxxx"
        .\tools\create-gitea-release.ps1

    默认发布 v1.1.3 到 http://192.168.1.82:3000/w/McServerManager，
    附件：GUI 便携版、纯 CLI 精简版、PLUGIN-SDK.md、官方玩家管理插件。
    已存在同名 Release 时会复用并补传缺失附件。
#>
param(
    [string]$BaseUrl = "http://192.168.1.82:3000",
    [string]$Owner = "w",
    [string]$Repo = "McServerManager",
    [string]$Version = "1.1.3",
    [string]$Tag = "",
    [string]$Title = "",
    [string]$NotesFile = "",
    [string[]]$Assets = @(),
    [string]$Token = $env:GITEA_TOKEN,
    [switch]$Draft
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $Tag) { $Tag = "v$Version" }
if (-not $Title) { $Title = "McServerManager $Version · Windows 便携版" }
if (-not $NotesFile) { $NotesFile = "docs\RELEASE_NOTES-$Version.md" }
if ($Assets.Count -eq 0) {
    $Assets = @(
        "dist\McServerManager-$Version-win64.zip",
        "dist\McServerManager-$Version-win64-cli.zip",
        "docs\PLUGIN-SDK.md",
        "dist\plugins\com.mcsm.player-admin-1.0.0.zip"
    )
}

if (-not $Token) {
    throw @"
缺少 Gitea 令牌。请先在 Gitea 生成：
  $BaseUrl/user/settings/applications
然后：
  `$env:GITEA_TOKEN = "xxxxxxxx"
"@
}
if (-not (Test-Path $NotesFile)) { throw "找不到发行说明：$NotesFile" }
foreach ($asset in $Assets) {
    if (-not (Test-Path $asset)) { throw "找不到附件：$asset" }
}

$headers = @{
    Authorization = "token $Token"
    Accept        = "application/json"
    'User-Agent'  = 'mcsm-gitea-release'
}
$api = "$BaseUrl/api/v1/repos/$Owner/$Repo"
$body = [System.IO.File]::ReadAllText((Resolve-Path $NotesFile), [System.Text.Encoding]::UTF8)

Write-Host "release : $Tag  ($Owner/$Repo @ $BaseUrl)" -ForegroundColor Cyan
foreach ($asset in $Assets) { Write-Host ("asset   : {0}  ({1:N1} MB)" -f $asset, ((Get-Item $asset).Length / 1MB)) }

$release = $null
try {
    $release = Invoke-RestMethod -Uri "$api/releases/tags/$Tag" -Headers $headers -TimeoutSec 60
    Write-Host "已存在同名 Release，复用并补传附件" -ForegroundColor Yellow
} catch {
    $payload = @{
        tag_name   = $Tag
        name       = $Title
        body       = $body
        draft      = [bool]$Draft
        prerelease = $false
    } | ConvertTo-Json -Depth 4
    try {
        $release = Invoke-RestMethod -Uri "$api/releases" -Method Post -Headers $headers `
                                     -ContentType 'application/json; charset=utf-8' `
                                     -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 120
    } catch {
        $detail = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        throw "创建 Gitea Release 失败：$detail"
    }
    Write-Host "已创建 Release" -ForegroundColor Green
}

$existing = @()
try { $existing = @($release.assets | ForEach-Object { $_.name }) } catch { }
$curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if (-not $curl) { $curl = (Get-Command curl -ErrorAction SilentlyContinue).Source }

foreach ($asset in $Assets) {
    $name = Split-Path $asset -Leaf
    if ($existing -contains $name) {
        Write-Host "附件已存在，跳过：$name" -ForegroundColor DarkGray
        continue
    }
    $upload = "$api/releases/$($release.id)/assets?name=$([uri]::EscapeDataString($name))"
    if ($curl) {
        $output = & $curl -sS -X POST -H "Authorization: token $Token" -H "User-Agent: mcsm-gitea-release" `
                          -F "attachment=@$((Resolve-Path $asset).Path)" $upload 2>&1
        if ($LASTEXITCODE -ne 0) { throw "上传附件失败：$name -> $output" }
        Write-Host "已上传：$name" -ForegroundColor Green
    } else {
        throw "找不到 curl.exe，无法上传附件 $name"
    }
}

Write-Host ""
Write-Host ("release 页面：{0}/{1}/{2}/releases/tag/{3}" -f $BaseUrl, $Owner, $Repo, $Tag) -ForegroundColor Cyan
