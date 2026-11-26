<#
    创建 Gitea Release 并上传附件（与 create-release.ps1 对应）。

    需要一个 Gitea 访问令牌（设置 → 应用 → 生成令牌，至少 repository 读写）：

        $env:GITEA_URL = "http://gitea.example.lan:3000"
        $env:GITEA_TOKEN = "xxxxxxxx"
        .\tools\create-gitea-release.ps1

    仓库地址必须通过 -BaseUrl 或环境变量 GITEA_URL 提供。
    附件：GUI 便携版、纯 CLI 精简版、PLUGIN-SDK.md、官方玩家管理插件。
    已存在同名 Release 时会复用并补传缺失附件。
#>
param(
    [string]$BaseUrl = $env:GITEA_URL,
    [string]$Owner = "w",
    [string]$Repo = "McServerManager",
    [string]$Version = "",
    [string]$Tag = "",
    [string]$Title = "",
    [string]$NotesFile = "",
    [string[]]$Assets = @(),
    [string]$Token = $env:GITEA_TOKEN,
    [switch]$Draft
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "script-common.ps1")
if (-not $Version) { $Version = Get-ProjectVersion -ProjectRoot $projectRoot }

if (-not $Tag) { $Tag = "v$Version" }
if (-not $Title) { $Title = "McServerManager $Version · Windows 便携版" }
if (-not $NotesFile) { $NotesFile = "docs\RELEASE_NOTES-$Version.md" }
if ($Assets.Count -eq 0) {
    $Assets = @(
        "dist\McServerManager-$Version-win64.zip",
        "dist\McServerManager-$Version-win64.zip.sha256",
        "dist\McServerManager-$Version-win64-cli.zip",
        "dist\McServerManager-$Version-win64-cli.zip.sha256",
        "docs\PLUGIN-SDK.md",
        "dist\plugins\com.mcsm.player-admin-1.1.0.zip"
    )
}

if (-not $BaseUrl) {
    throw "缺少 Gitea 地址。请通过 -BaseUrl 或环境变量 GITEA_URL 提供（本地自托管可使用 http）。"
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

foreach ($asset in $Assets) {
    $name = Split-Path $asset -Leaf
    if ($existing -contains $name) {
        Write-Host "附件已存在，跳过：$name" -ForegroundColor DarkGray
        continue
    }
    $upload = "$api/releases/$($release.id)/assets?name=$([uri]::EscapeDataString($name))"
    $client = New-Object System.Net.Http.HttpClient
    $stream = $null
    $form = $null
    try {
        $client.DefaultRequestHeaders.Authorization =
            New-Object System.Net.Http.Headers.AuthenticationHeaderValue("token", $Token)
        $client.DefaultRequestHeaders.UserAgent.ParseAdd("mcsm-gitea-release")
        $stream = [System.IO.File]::OpenRead((Resolve-Path -LiteralPath $asset).Path)
        $fileContent = New-Object System.Net.Http.StreamContent($stream)
        $fileContent.Headers.ContentType =
            New-Object System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream")
        $form = New-Object System.Net.Http.MultipartFormDataContent
        $form.Add($fileContent, "attachment", $name)
        $response = $client.PostAsync($upload, $form).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            $detail = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            throw ("HTTP {0}: {1}" -f [int]$response.StatusCode, $detail)
        }
        Write-Host "已上传：$name" -ForegroundColor Green
    } catch {
        throw "上传附件失败：$name -> $($_.Exception.Message)"
    } finally {
        if ($form) { $form.Dispose() }
        if ($stream) { $stream.Dispose() }
        $client.Dispose()
    }
}

Write-Host ""
Write-Host ("release 页面：{0}/{1}/{2}/releases/tag/{3}" -f $BaseUrl, $Owner, $Repo, $Tag) -ForegroundColor Cyan
