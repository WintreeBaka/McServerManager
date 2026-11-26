# McServerManager Developer Guide

This guide is for contributors who need to modify the C++ applications, build manager
plugins, add tests, or publish a release. It connects the setup and workflow details
spread across the README, architecture notes, protocol reference, and project scripts.

Chinese version: [DEVELOPMENT.zh-CN.md](DEVELOPMENT.zh-CN.md)

## 1. System boundaries

The product consists of two independent processes:

| Executable | Source | Responsibility |
| --- | --- | --- |
| `McServerManager` | `frontend/` | Qt Widgets UI, themes, animations, plugin frontend host |
| `mcsm-cli` | `backend/` | Docker, downloads, configuration, backups, RCON, plugins, schedules |

They communicate only through JSON over standard input and output. The UI must not
manipulate Docker or server files directly. Business capabilities belong in the backend
and are called through `BackendClient`.

Read these documents next:

- [Architecture](ARCHITECTURE.md)
- [CLI reference](CLI.md)
- [Process protocol](PROTOCOL.md)
- [Plugin SDK](PLUGIN-SDK.md)

## 2. Prerequisites

### Required

- CMake 3.19 or newer
- A C++17 compiler
- Qt 6.4 or newer with Core, Gui, Widgets, Network, and Qml
- Git

On Windows, the recommended setup is a Qt Online Installer `mingw_64` kit with the
matching MinGW toolchain and Ninja. Linux can use the distribution Qt packages or the
official installer. macOS can use an official Qt kit.

### Optional, depending on the task

- Docker Desktop for container lifecycle, log, backup, and image integration tests
- Node.js for official plugin backend code and `node --check`
- Python 3 for static checks, upstream API probes, and RCON diagnostics
- PowerShell 7 or Windows PowerShell 5.1 for Windows builds, smoke tests, and releases

The repository bundles 7-Zip. Plugin installation and packaging do not require a system
7-Zip installation. Do not replace files under `third_party/7zip/` casually; run
`tools/verify-third-party.ps1` after any intentional update.

## 3. First build

### Windows with automatic discovery

```powershell
git clone https://github.com/WintreeBaka/McServerManager.git
cd McServerManager
.\scripts\build-windows.ps1
```

The script discovers Qt, its matching MinGW runtime, Ninja, and CMake, then updates the
current process `PATH`. Default outputs:

```text
build\bin\mcsm-cli.exe
build\bin\McServerManager.exe
```

Select a kit explicitly and deploy the portable Qt runtime:

```powershell
.\scripts\build-windows.ps1 -QtDir "C:\Qt\6.8.3\mingw_64" -Deploy
```

Recreate the build directory:

```powershell
.\scripts\build-windows.ps1 -QtDir "C:\Qt\6.8.3\mingw_64" -Reconfigure
```

`-Reconfigure` refuses unsafe deletion. The target must contain the `.mcsm-managed`
marker and must not be a drive root or sensitive system directory. A `build/` directory
created by an older release may not have the marker; use a new `-BuildDir build-new`
instead of bypassing the guard.

### Linux and macOS

```bash
./scripts/build-unix.sh /path/to/Qt/6.8.3/gcc_64
```

### Manual CMake

```bash
cmake -S . -B build \
  -DCMAKE_PREFIX_PATH=/path/to/Qt/6.8.3/gcc_64 \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
```

CMake is the single source of truth for the application version.
`project(... VERSION ...)` injects `MCSM_VERSION` into both executables, and release
scripts read the same value. Do not duplicate the version manually.

## 4. Run against isolated development data

First verify that the backend starts:

```powershell
.\build\bin\mcsm-cli.exe version
.\build\bin\mcsm-cli.exe doctor
```

Use a disposable data root while developing:

```powershell
$devHome = Join-Path $env:TEMP "mcsm-dev"
.\build\bin\mcsm-cli.exe --home $devHome version
```

```bash
mcsm-cli --home /tmp/mcsm-dev version
```

Start the desktop application:

```powershell
.\build\bin\McServerManager.exe
```

The UI searches for the backend next to its executable, under `backend/`, `bin/`,
`build/bin/`, and on `PATH`. It can also be selected under Settings → Runtime or supplied
through `MCSM_BACKEND`. Backend data-root precedence is `--home`, `MCSM_HOME`, then the
platform default.

Never commit development data. `servers.json` contains RCON credentials. Configuration
backups, world backups, container packages, and logs can also contain sensitive data.

## 5. Source map

```text
backend/src/
  cli/       argument parsing and command routing
  core/      paths, JSON, logging, process execution, archives
  net/       HTTP and version resolution
  docker/    Docker commands and generated templates
  java/      JDK images and host JDK discovery
  server/    records, installation, lifecycle, RCON
  config/    server.properties schema and safe writes
  backup/    archives, restore, retention
  plugin/    packages, runtime, hooks
  schedule/  daemon and scheduled work

frontend/src/
  app/       application context, themes, backend client, shared constants
  model/     server models
  plugin/    QJSEngine plugin host and mcsm.* API
  ui/        main window, title bar, navigation, toasts
  widgets/   animation, logs, cards, reusable controls
  pages/     product pages and plugin page renderer

plugins/official/   official manager plugins
examples/plugins/   installable examples and packaging scripts
tools/              checks, smoke tests, packaging, releases
scripts/            platform build entry points
packaging/          quick-start files included in releases
```

## 6. Test matrix

### Before every commit

```powershell
python tools/static_check.py
.\build\bin\mcsm-cli.exe version
.\tools\smoke-test.ps1 -Exe .\build\bin\mcsm-cli.exe
```

The smoke suite does not require Docker. It covers protocol envelopes, install/validation,
configuration, backups, package handling, RCON safety boundaries, corrupt registry
preservation, and version consistency. Explicit runtime locations can be supplied:

```powershell
.\tools\smoke-test.ps1 `
  -Exe .\build\bin\mcsm-cli.exe `
  -QtBin "C:\Qt\6.8.3\mingw_64\bin" `
  -MinGwBin "C:\Qt\Tools\mingw1310_64\bin"
```

### UI changes

```powershell
.\tools\gui-smoke.ps1 -Screenshot .\build\gui-smoke.png
```

This starts the real desktop application, finds the largest visible titled window, checks
that it remains alive, captures a screenshot, closes it, and verifies that no backend
daemon is left behind. Add `-Page settings-runtime -Resize 1100x700` for a layout case.

### Plugin changes

```powershell
node --check plugins\official\container-porter\backend\index.js
node --check plugins\official\player-admin\backend\lib\mcsm.js
.\plugins\build-plugins.ps1
```

Install and invoke each affected plugin at least once:

```powershell
.\build\bin\mcsm-cli.exe --home $devHome plugin package inspect --zip .\dist\plugins\<plugin>.zip
.\build\bin\mcsm-cli.exe --home $devHome plugin package install --zip .\dist\plugins\<plugin>.zip
.\build\bin\mcsm-cli.exe --home $devHome plugin call --name <plugin-id> --method <method>
```

### Dependency and release tooling changes

```powershell
.\tools\verify-third-party.ps1
python tools\check-endpoints.py
```

The endpoint probe requires network access. A transient upstream failure is not a code
failure, but integrations used by a release should still be checked before publishing.

## 7. Common implementation workflows

### 7.1 Add a backend command

1. Parse options in `backend/src/cli/ArgParser`.
2. Route the action explicitly in `CommandRouter::dispatch`.
3. Put domain logic in the appropriate service and return the standard `Result` envelope.
4. Give every failure a stable code, readable message, and actionable detail.
5. Update `docs/CLI.md`, `docs/PROTOCOL.md`, and smoke-test both success and failure.
6. Keep stdout machine-readable; diagnostics belong in `Logger`.

Services must not depend on the GUI. Prefer `ProcessRunner` for external processes rather
than adding another PID, timeout, taskkill, or `/proc` implementation.

### 7.2 Add a UI page or interaction

1. Derive from the existing `PageBase`; put the side column in `setSideColumn()`.
2. Use asynchronous `BackendClient` requests; never block the UI thread.
3. Check `reply.ok` and surface failures in a status label, banner, toast, or log.
4. Bound logs, lists, plugin output, and pending work.
5. Debounce expensive filtering and rebuilding.
6. Put shared sizes, intervals, and limits in `frontend/src/app/Constants.h`.
7. Test theme changes, resizing, rapid page switching, and object lifetime.

Use `QStringLiteral` for user-visible Chinese text. `QLatin1String` must not wrap non-ASCII
content.

### 7.3 Add a `server.properties` field

The field catalog is in `ConfigSchema`; preservation and write logic is in
`ConfigManager`. New fields should define type, default, options, and help text without
changing comments, blank lines, or unknown keys. Add tests for invalid values, empty
values, unknown choices, snapshot creation, and rollback. Verify that the editor preserves
an existing unrecognized value.

### 7.4 Develop a manager plugin

Use `docs/PLUGIN-SDK.md` as the complete API reference. Start from
`examples/plugins/hello-panel` or `examples/plugins/ops-console`.

```powershell
.\plugins\build-plugins.ps1
.\build\bin\mcsm-cli.exe --home $devHome plugin package inspect --zip .\dist\plugins\<plugin>.zip
.\build\bin\mcsm-cli.exe --home $devHome plugin package install --zip .\dist\plugins\<plugin>.zip
.\build\bin\mcsm-cli.exe --home $devHome plugin call --name <plugin-id> --method <method>
```

Important constraints:

- Packages must remain inside the manager data directory; reject absolute paths, `..`,
  escaping symlinks, and hard links.
- Frontend plugins run in `QJSEngine` with no native file or process access.
- Backend plugins are separate processes using one JSON request line and one JSON response
  line. Request lines have a size limit.
- Plugins must not write `servers.json` directly. Use controlled registration:
  `mcsm-cli server register --file <record.json>`.
- Plugin access is restricted to its own data directory. Server paths must resolve inside
  `<root>/servers`.
- Online-mode plugins must not guess offline UUIDs. When RCON is unavailable, do not edit
  player files behind the running server.
- Keep the SDK, examples, compatibility notes, and plugin smoke tests synchronized with
  any API change.

### 7.5 Change process or container lifecycle

Use the centralized `ProcessRunner` helpers. Never add a second `tasklist`, `/proc`, or
unconditional `taskkill` implementation. A PID can be reused, so important lifecycle
checks must verify the executable image and expected command-line markers. On POSIX,
timeouts must terminate the child process group. Windows tree termination must have a
timeout. Recursive helper execution needs a depth guard. An open port alone does not prove
ownership of the process.

## 8. Concurrency, data, and security rules

### Single writer for `servers.json`

`ServerStore` uses an in-process mutex and file lock around the full
reload → validate → mutate → write transaction. Do not read the file elsewhere and append
records. Import through:

```powershell
.\build\bin\mcsm-cli.exe --home $devHome server register --file .\record.json
```

### Path boundaries

- Server directories must resolve under `<root>/servers`.
- `jarName` must be a plain filename, not a path or `..` component.
- Extractors must reject traversal, special links, and oversized entries.
- Recursive deletion scripts must verify roots, sensitive directories, and the
  `.mcsm-managed` marker.

### Credentials

- Never log RCON passwords, tokens, or complete authentication packets.
- Tokens belong in environment variables or authorization headers, not command lines.
- Treat `servers.json`, configuration backups, world backups, and container packages as
  sensitive assets.

### Asynchronous work and resource limits

- Plugin scripts and async callbacks must run under execution budgets and isolation.
- Stream output must cap line size, total buffering, and pending rows.
- Debounce high-frequency filtering and page rebuilding.
- Every QProcess/QObject failure and timeout path must release resources.

## 9. Debugging

### Backend

```powershell
.\build\bin\mcsm-cli.exe --verbose --home $devHome doctor
```

Diagnostic JSON Lines are written to `<data root>/logs/backend.log` and rotate by size.
Warnings and errors flush immediately; normal records are batched. Command-line mode
flushes before exit.

When debugging protocol output, verify the final line is a complete JSON envelope and that
streaming commands emit valid NDJSON. An exit code alone is not sufficient.

### Desktop UI

- Confirm which `mcsm-cli` the GUI actually launched.
- Check Settings → Runtime for backend path and data root.
- Capture a real window with `tools/gui-smoke.ps1 -Screenshot`.
- Inspect backend logs and request errors rather than inferring success from button state.

### Plugins

- Run `plugin package inspect` before installation.
- Install into an isolated `--home`.
- Run `node --check` on backend plugin sources.
- Check plugin stderr, page errors, notifications, and watchdog/quarantine behavior.

## 10. Coding conventions

- C++17, namespace `mcsm`, four-space indentation.
- Header and source names match; add every new file to the correct `CMakeLists.txt`.
- Prefer Qt containers, JSON, and device classes; propagate errors explicitly.
- Use `QStringLiteral` for user-visible text and keep the existing mixed comment style.
- Do not embed drive letters, personal directories, or test tokens in code or scripts.
- A new dependency needs a purpose, license, source, integrity check, and maintenance
  rationale.
- Shared timeouts, limits, and animation durations belong in a common constants file.
- Protocol, storage-format, or compatibility changes require version, docs, and tests.

Before committing:

```powershell
git diff --check
python tools\static_check.py
.\tools\smoke-test.ps1 -Exe .\build\bin\mcsm-cli.exe
```

## 11. Build and publish a 1.2.x release

CMake `project(VERSION)` is authoritative. Update `CHANGELOG.md` and
`docs/RELEASE_NOTES-<Version>.md` before packaging.

```powershell
.\scripts\build-windows.ps1 -QtDir "C:\Qt\6.8.3\mingw_64" -Deploy
.\plugins\build-plugins.ps1
.\tools\package-release.ps1
.\tools\package-release.ps1 -Flavor cli
```

Typical assets:

```text
dist\McServerManager-<Version>-win64.zip
dist\McServerManager-<Version>-win64.zip.sha256
dist\McServerManager-<Version>-win64-cli.zip
dist\McServerManager-<Version>-win64-cli.zip.sha256
dist\plugins\com.mcsm.player-admin-1.1.0.zip
```

Final validation:

```powershell
.\tools\verify-third-party.ps1
python tools\static_check.py
.\tools\smoke-test.ps1 -Exe .\build\bin\mcsm-cli.exe
.\tools\gui-smoke.ps1 -Screenshot .\build\gui-smoke-release.png
Get-FileHash .\dist\McServerManager-<Version>-win64.zip -Algorithm SHA256
```

Pushing Git history and creating a release are separate steps. Commit and push code and
the version tag first, then run `tools/create-release.ps1` and
`tools/create-gitea-release.ps1`. Tokens are supplied only through environment variables.
Verify tags, release notes, assets, and SHA-256 files on both remotes.

## 12. Pre-commit checklist

- The CMake version is the only version source and release/changelog files are updated.
- New source, header, and resource files are listed in CMake.
- UI failures are visible and asynchronous work does not block the UI thread.
- Every new list, log, and stream buffer has a limit.
- Filesystem access validates a real path, and `servers.json` writes go through
  `ServerStore`.
- External processes go through `ProcessRunner`; lifecycle checks verify image/command.
- Plugins do not log credentials or place tokens on command lines.
- `git diff --check`, static checks, backend smoke tests, and focused tests pass.
- Review GUI screenshots when UI changed; use disposable data for container end-to-end
  tests.
- Planning notes, build output, release artifacts, development data, and logs are not
  committed.
