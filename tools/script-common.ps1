# Shared helpers for local build, smoke-test and release scripts.

function Get-ProjectVersion {
    param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))

    $cmake = Join-Path $ProjectRoot "CMakeLists.txt"
    if (-not (Test-Path -LiteralPath $cmake)) {
        throw "CMakeLists.txt not found: $cmake"
    }
    $text = Get-Content -LiteralPath $cmake -Raw -Encoding UTF8
    $match = [regex]::Match($text, 'project\s*\(\s*McServerManager\s+VERSION\s+([0-9]+(?:\.[0-9]+){1,3})', 'IgnoreCase')
    if (-not $match.Success) {
        throw "project(McServerManager VERSION ...) not found in $cmake"
    }
    return $match.Groups[1].Value
}

function Find-QtKit {
    param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))

    $qmake = Get-Command qmake.exe, qmake6.exe, qmake -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($qmake) {
        $kit = Split-Path -Parent (Split-Path -Parent $qmake.Source)
        if (Test-Path -LiteralPath (Join-Path $kit "bin")) {
            return (Resolve-Path -LiteralPath $kit).Path
        }
    }

    $roots = @()
    if ($env:QT_ROOT) { $roots += $env:QT_ROOT }
    $roots += @(
        (Join-Path $env:USERPROFILE "Qt"),
        "C:\Qt"
    )
    $roots = $roots | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

    $candidates = @()
    foreach ($root in $roots) {
        $candidates += Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\d+\.\d+' } |
            ForEach-Object {
                Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -match '^(mingw|msvc)' }
            }
    }
    if ($candidates.Count -eq 0) { return "" }

    $ranked = $candidates | ForEach-Object {
        $numeric = $_.Parent.Name -replace '[^0-9.]', ''
        $version = $null
        if ([version]::TryParse($numeric, [ref]$version)) {
            [pscustomobject]@{ Path = $_.FullName; Version = $version }
        }
    } | Sort-Object Version -Descending
    if ($ranked) { return $ranked[0].Path }
    return $candidates[0].FullName
}

function Resolve-QtRuntime {
    param([string]$QtKit)

    if (-not $QtKit) {
        $QtKit = Find-QtKit
    }
    if (-not $QtKit -or -not (Test-Path -LiteralPath $QtKit)) {
        throw "no Qt kit found; pass -QtDir/-QtBin or set QT_ROOT"
    }
    $QtKit = (Resolve-Path -LiteralPath $QtKit).Path
    $qtBin = Join-Path $QtKit "bin"
    if (-not (Test-Path -LiteralPath (Join-Path $qtBin "Qt6Core.dll"))) {
        throw "Qt kit does not contain bin\Qt6Core.dll: $QtKit"
    }

    $toolsRoot = Split-Path (Split-Path $QtKit -Parent) -Parent
    $minGwBin = ""
    $tools = Join-Path $toolsRoot "Tools"
    if (Test-Path -LiteralPath $tools) {
        $mingw = Get-ChildItem -LiteralPath $tools -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^mingw' } |
            Sort-Object Name -Descending |
            Select-Object -First 1
        if ($mingw) { $minGwBin = Join-Path $mingw.FullName "bin" }
    }
    return [pscustomobject]@{
        Kit = $QtKit
        Bin = $qtBin
        MinGwBin = $minGwBin
    }
}

function Add-RuntimePath {
    param([string[]]$Paths)

    foreach ($path in $Paths) {
        if ($path -and (Test-Path -LiteralPath $path)) {
            $resolved = (Resolve-Path -LiteralPath $path).Path
            if (($env:PATH -split ';') -notcontains $resolved) {
                $env:PATH = "$resolved;$env:PATH"
            }
        }
    }
}

function Assert-SafeRemovalTarget {
    param([string]$Path, [string]$MarkerName = ".mcsm-managed")

    if (-not $Path) { throw "refusing to remove an empty path" }
    if ([System.IO.Path]::IsPathRooted($Path)) {
        $full = [System.IO.Path]::GetFullPath($Path)
    } else {
        $full = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
    }
    $full = $full.TrimEnd('\', '/')
    $root = [System.IO.Path]::GetPathRoot($full).TrimEnd('\', '/')
    if (-not $full -or $full -eq $root) {
        throw "refusing to remove a drive or filesystem root: $full"
    }
    foreach ($sensitive in @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:ProgramFiles, $env:WINDIR)) {
        if ($sensitive) {
            $prefix = [System.IO.Path]::GetFullPath($sensitive).TrimEnd('\', '/')
            if ($full.Equals($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "refusing to remove a sensitive directory: $full"
            }
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $full $MarkerName))) {
        throw "refusing recursive removal without $MarkerName marker: $full"
    }
    return $full
}

function Remove-ManagedDirectory {
    param([string]$Path, [string]$MarkerName = ".mcsm-managed")

    $full = Assert-SafeRemovalTarget -Path $Path -MarkerName $MarkerName
    Remove-Item -LiteralPath $full -Recurse -Force
}

function Set-ManagedMarker {
    param([string]$Path, [string]$MarkerName = ".mcsm-managed")

    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $marker = Join-Path $Path $MarkerName
    if (-not (Test-Path -LiteralPath $marker)) {
        Set-Content -LiteralPath $marker -Value "This directory is created and may be replaced by McServerManager scripts." -Encoding ASCII
    }
}

function Get-Sha256File {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
