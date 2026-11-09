# 工作区载入说明（WORKSPACE）

> 给新的开发工作区 / AI 助手 / 协作者：**读完这一页即可构建、运行、测试、打包、发版与同步**。
> 当前版本 **1.1.3**，分支 `main`，后端 `mcsm-cli` + Qt Widgets 桌面端。

## 1. 项目一览

| 项 | 内容 |
| --- | --- |
| 名称 | McServerManager（我的世界服务器管理器） |
| 架构 | Qt 6 Widgets 桌面端 ↔ `mcsm-cli` CLI 后端（JSON over stdout / NDJSON 流） |
| 运行时 | 每个服务器一台 Docker 容器（eclipse-temurin JDK），宿主无需 Java |
| 插件 | 管理器插件包（Plugin SDK，apiVersion=1）；官方插件在 `plugins/official/` |
| 许可 | 代码 MIT；Qt 个人版/开源条款；内置 7-Zip LGPL（见 THIRD_PARTY_NOTICES.md） |

## 2. 仓库与同步

| 远端 | 地址 | 用途 |
| --- | --- | --- |
| `origin` | `git@github.com:WintreeBaka/McServerManager.git` | 主仓库（GitHub） |
| `gitea` | `git@gitea:w/McServerManager.git`（SSH 端口 222；Web/API `http://192.168.1.82:3000`） | 个人 Gitea；**仓库尚未创建**（该实例已禁用 push-to-create） |
| `legacy` | `git@github.com:WintreeBaka/mc-server-manager.git` | 旧仓库，**已归档**；push 已禁用 |

同步说法：

* **同步本地仓库**：`git add -A && git commit`（可加 `git tag`）
* **同步个人 gitea**：`git push gitea main && git push gitea --tags`
* **同步 github**：`git push origin main && git push origin --tags`

> Gitea 的 API 在 `http://192.168.1.82:3000/api/v1`（Web/API 端口 3000，SSH 222）。
> 建库 / 发 Release 需要 Gitea 访问令牌（`write:repository` + `write:package` 或对应仓库权限）。
> 当前状态：SSH 认证为 `w` 正常，但 `w/McServerManager` 还没有创建，且
> `Push to create is not enabled for users`；需要先在 Gitea Web 新建空仓库
> `w/McServerManager`（或在 API 用令牌 POST `/api/v1/user/repos`），之后才能 `git push gitea`。

## 3. 必需环境

| 工具 | 本机路径 / 版本 |
| --- | --- |
| Qt | `D:\qt\6.11.2\mingw_64`（需要 Qml 模块：QJSEngine 插件宿主） |
| MinGW | `D:\qt\Tools\mingw1310_64`（GCC 13.1） |
| CMake / Ninja | `D:\qt\Tools\CMake_64` / `D:\qt\Tools\Ninja` |
| Docker | Docker Desktop（容器运行必需；CI 上不可用） |
| 可选 | Node.js（后端插件示例）、Python（工具/冒烟测试）、7-Zip（已内置，仅开发时可用系统版） |

## 4. 首次载入与构建

```powershell
cd "C:\Users\Administrator\Documents\ChatGPT\mc servers"   # 开发工作区

$env:PATH = "D:\qt\Tools\mingw1310_64\bin;D:\qt\Tools\Ninja;D:\qt\Tools\CMake_64\bin;$env:PATH"

cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release `
      -DCMAKE_PREFIX_PATH=D:\qt\6.11.2\mingw_64 `
      -DCMAKE_MAKE_PROGRAM=D:\qt\Tools\Ninja\ninja.exe `
      -DCMAKE_C_COMPILER=D:\qt\Tools\mingw1310_64\bin\gcc.exe `
      -DCMAKE_CXX_COMPILER=D:\qt\Tools\mingw1310_64\bin\g++.exe

cmake --build build --parallel 4
```

> 编译器进程若报 `0xC0000135`，说明 `mingw1310_64\bin` 不在 PATH（GCC 找不到自己的 DLL）。
> **构建必须跳出受限沙箱**（沙箱内 `cmake`/`ninja` 会卡在启动阶段）。

产物：`build\bin\McServerManager.exe`、`build\bin\mcsm-cli.exe`。

## 5. 运行

```powershell
# 桌面端（需要 Qt DLL 在 PATH 或已部署到 build\bin）
$env:PATH = "D:\qt\6.11.2\mingw_64\bin;$env:PATH"
.\build\bin\McServerManager.exe

# CLI 自检 / 服务器列表
.\build\bin\mcsm-cli.exe doctor
.\build\bin\mcsm-cli.exe server list

# 不带参数时数据目录：%LOCALAPPDATA%\McServerManager
# 测试时建议隔离： --home build\test-home 或 $env:MCSM_HOME
```

GUI 深链接：`--page dashboard|servers|console|config|backup|plugin|settings|settings-plugins|settings-runtime`
以及插件页面 id（如 `--page player-admin`）。

## 6. 测试（改完必须跑）

```powershell
python tools\static_check.py                       # 106 文件；0 error / 0 warning
powershell -File tools\smoke-test.ps1              # 73 项（含审计回归），不需要 Docker
powershell -File tools\gui-smoke.ps1 -Screenshot smoke.png
powershell -File tools\gui-smoke.ps1 -TestDrag -TestPageSwitch
powershell -File tools\ui-perf.ps1 -Mode cycle -IntervalMs 60 -Seconds 15

# 严格警告（独立 build 目录，确认 0 warning）
cmake -S . -B build-warn -G Ninja -DCMAKE_BUILD_TYPE=Release `
  -DCMAKE_PREFIX_PATH=D:\qt\6.11.2\mingw_64 `
  '-DCMAKE_CXX_FLAGS=-Wall -Wextra -Wpedantic -Wshadow -Wnon-virtual-dtor -Woverloaded-virtual'
cmake --build build-warn --parallel 4
```

`smoke-test.ps1` 使用 `-home` 隔离数据并在结束时清理；不要把它指向真实数据目录。
所有测试/构建/GUI 启动都需要在**非沙箱**环境下执行（QProcess 管道会被沙箱拦截）。

## 7. 打包（三种 flavor）

```powershell
# 含 GUI 的便携版（先 deploy 过 Qt 运行库）
.\tools\package-release.ps1 -Flavor plain

# 额外带示例插件包（plugin-packages\*.zip）
.\tools\package-release.ps1 -Flavor with-plugins

# 纯 CLI 精简版（windeployqt 只部署 Core/Network，约 6.5 MB）
.\tools\package-release.ps1 -Flavor cli
```

输出：

```
dist\McServerManager-1.1.3-win64\              GUI 便携版
dist\McServerManager-1.1.3-win64-with-plugins\ GUI + 示例插件包
dist\McServerManager-1.1.3-win64-cli\          纯 CLI（mcsm-cli.exe + Qt Core/Network + 7zip）
```

CLI 包里**不应**出现 `McServerManager.exe`、`Qt6Widgets/Qt6Gui/Qt6Qml`；验证：

```powershell
$saved=$env:PATH; $env:PATH="C:\Windows\system32;C:\Windows"
.\dist\McServerManager-1.1.3-win64-cli\mcsm-cli.exe version
$env:PATH=$saved
```

## 8. 版本与发布流程

1. 修改代码 + 补测试，跑第 6 节全部检查。
2. 改版本号（当前 **1.1.3**，发新版时统一替换）：
   `CMakeLists.txt`、`backend/src/main.cpp`、`frontend/src/main.cpp`、
   `packaging/QUICKSTART.txt`、`tools/package-release.ps1`、`tools/create-release.ps1`、
   `backend/src/plugin/PackageManager.cpp` 的回退版本、README 的打包示例。
3. 写 `CHANGELOG.md` 条目与 `docs/RELEASE_NOTES-<版本>.md`。
4. 重新构建 + `python tools/static_check.py` + `smoke-test.ps1`（73 项）+ `gui-smoke.ps1`。
5. 打三种包（plain / with-plugins / cli）。
6. `git commit` → `git tag -a v<版本>`。
7. 推送到 Gitea / GitHub（按第 2 节命令）。
8. 两个平台各建 Release，**附件固定为**：
   - `McServerManager-<版本>-win64.zip`（GUI）
   - `McServerManager-<版本>-win64-cli.zip`（纯 CLI）
   - `PLUGIN-SDK.md`（接口文档）
   - `com.mcsm.player-admin-1.0.0.zip`（官方插件）

GitHub 发布脚本（需要 `GITHUB_TOKEN`）：

```powershell
$env:GITHUB_TOKEN = "<token>"
.\tools\create-release.ps1 -Version 1.1.3 `
  -Assets @('dist\McServerManager-1.1.3-win64.zip',
            'dist\McServerManager-1.1.3-win64-cli.zip',
            'docs\PLUGIN-SDK.md',
            'dist\plugins\com.mcsm.player-admin-1.0.0.zip')
```

Gitea 发布可用 `POST /api/v1/repos/w/McServerManager/releases` +
`POST /api/v1/repos/w/McServerManager/releases/{id}/assets?name=<file>`（需要令牌）。

## 9. 代码地图

```
backend/src/
  cli/      参数解析(ArgParser) · 命令路由(CommandRouter)
  core/     路径 · 日志 · 进程 · JSON · 字符串 · 内置 7-Zip 解压(Archive)
  net/      HTTP 下载 · 版本解析（Mojang/Paper/Purpur/Fabric）
  docker/   容器生命周期 · 生成 start.sh / compose / 启动脚本
  java/     JDK 镜像管理 · 本机 JDK 扫描
  server/   记录/注册表 · 安装器 · 生命周期 · RCON
  config/   server.properties 字段表 · 原子写入 · 备份回滚
  backup/   存档打包/恢复（先回滚目录） · 保留策略
  plugin/   服务器插件市场(PluginManager) · 管理器插件包(PackageManager) · 运行时(PluginRuntime)
  schedule/ 定时备份守护进程（--parent-pid）

frontend/src/
  app/      主题(ThemeManager) · 动画缓动(Easing) · 后端通信 · AppContext
  plugin/   PluginHost（QJSEngine + mcsm.* API + 看门狗/代际校验）
  ui/       主窗口/标题栏/侧边栏/Toast/无边框拖动
  widgets/  渐变按钮 · 卡片 · 开关 · 分段控件 · 动画栈 · 日志视图
  pages/    总览/服务器/控制台/配置/备份/服务器插件/设置 + 插件扩展页/导入框/插件页渲染

plugins/official/player-admin/   官方玩家管理插件（global）
examples/plugins/                三个示例插件（前端/后端/全局）
docs/PLUGIN-SDK.md               插件接口详细文档
```

## 10. 关键约定（改代码前请读）

* **界面文案用 `QStringLiteral`**，不要用 `QLatin1String` 包中文（`tools/static_check.py` 会检查）。
* **不要阻塞 UI 线程**：不要 `waitForFinished/waitForStarted`；后端调用一律异步，
  插件脚本有看门狗，服务端请求有超时。
* **页面切换**：`MainWindow::navigateTo` 会调用离开页的 `onDeactivated()`；
  设置页左侧菜单必须放进 `PageBase::setSideColumn()`，不能放 `body()`（否则会被滚走）。
* **文件写入**：配置/注册表用 `QSaveFile`/`Json::writeObjectFile`（原子）；
  `servers.json` 有 `QLockFile`；损坏文件备份 `.broken-*`，不要清空重写。
* **端口**：`ServerStore::validatePorts()` 统一校验（范围、game≠rcon、跨服务器不重叠）。
* **插件安全**：安装目录只能在 `<数据目录>/plugins/`；压缩包条目与入口必须是安全相对路径；
  服务器插件 jar 文件名白名单；下载 URL 必须 https（localhost 例外）。
* **插件 API 版本**：`apiVersion` 是整数，`SUPPORTED_MIN_API..MAX_API`（当前 1..1）；
  破坏性变更抬 MIN，新增接口抬 MAX；`minManagerVersion` 仅提示。
* **Docker 状态**：查询失败返回 `unknown`，不要当成 stopped；`start` 前必须查状态（H1）。

## 11. 数据目录

```
%LOCALAPPDATA%\McServerManager\
├─ servers.json            服务器注册表（损坏时生成 .broken-<时间>）
├─ gui.ini                 界面设置
├─ logs/backend.log
├─ plugins/                管理器插件（registry.json、<id>/、.data/<id>/）
└─ servers/<id>/
   ├─ server.jar  server.properties  eula.txt  start.sh/.cmd
   ├─ .mcsm/               运行期状态（start-patch.json、save-suspended 等）
   ├─ plugins/ backups/ config-backups/ world*/ 
```

## 12. 已知边界 / 待办

* 审计 M17（本机模式 PID 身份/进程组跟踪）与 M18（CI 阻断式测试、单测、ASan/clang-tidy）尚未完成。
* GitHub Actions 只保证编译 + 静态检查；运行时冒烟在 CI 为非阻断（镜像缺少 Qt 6.6.3 配套 MinGW 11.2，
  ABI 混用会堆损坏）。本机发布前必须跑 73 项冒烟。
* Docker 未运行时容器相关端到端路径无法测试；H1/M5 的容器行为需在 Docker 可用时复测。
* 旧仓库 `mc-server-manager` 已归档；不要再向 `legacy` 推送（push URL 已禁用）。

## 13. 迁移到 dsh 工作区的检查清单

- [ ] 复制源码目录（**不要**复制 `build/`、`build-warn/`、`dist/`、`smoke-data/`、`*.zip`）
- [ ] 保留 `.git/`（含 `v1.1.3` 标签与远端配置）、`third_party/7zip/7za.exe`
- [ ] 保留 `docs/`、`examples/`、`plugins/`、`packaging/`、`tools/`
- [ ] 在新工作区设置第 4 节的 PATH 与 cmake 命令
- [ ] 跑 `static_check.py` + `smoke-test.ps1` 确认 73 项通过
- [ ] 若 Qt 路径不同，更新 `scripts/build-windows.ps1`、`tools/*.ps1` 的默认路径
- [ ] 重新配置 Git 远端（`origin` GitHub、`gitea` 个人 Gitea）并确认 SSH 可用
- [ ] 读取 `docs/PLUGIN-SDK.md` 再改动插件接口
