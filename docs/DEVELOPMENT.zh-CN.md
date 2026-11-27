# McServerManager 开发辅助文档

本文面向需要修改源码、开发管理器插件、补充测试或发布版本的人。它把散落在 README、
架构说明、协议文档和脚本中的开发信息串成一条可执行路径。

英文版本：[DEVELOPMENT.en.md](DEVELOPMENT.en.md)

## 1. 先了解项目边界

项目由两个独立进程组成：

| 程序 | 源码 | 职责 |
| --- | --- | --- |
| `McServerManager` | `frontend/` | Qt Widgets 界面、主题、动画、插件前端宿主 |
| `mcsm-cli` | `backend/` | Docker、下载、配置、备份、RCON、插件运行时、调度 |

两个进程只通过标准输入输出上的 JSON 通信。界面不能直接操作 Docker 或服务器文件；
新增业务能力应优先落在后端，再由 `BackendClient` 调用。

继续阅读：

- [架构说明](ARCHITECTURE.md)
- [CLI 参考](CLI.md)
- [前后端协议](PROTOCOL.md)
- [插件 SDK](PLUGIN-SDK.md)

## 2. 环境准备

### 必需

- CMake 3.19 或更高版本
- C++17 编译器
- Qt 6.4 或更高版本，组件包括 Core、Gui、Widgets、Network、Qml
- Git

Windows 推荐使用 Qt Online Installer 安装 `mingw_64` 套件，并同时安装与该 Qt
匹配的 MinGW 和 Ninja。Linux 可使用发行版 Qt 或 Qt Online Installer；macOS 可使用
官方 Qt 套件。

### 按开发内容可选

- Docker Desktop：涉及容器启动、日志、备份和镜像操作的端到端测试
- Node.js 24：运行 API 2 插件后端、Node Permission Model 权限测试和 `node --check` 语法检查
- Python 3：静态检查、上游 API 探针和 RCON 调试工具
- PowerShell 7 或 Windows PowerShell 5.1：Windows 构建、冒烟测试与发布脚本

仓库自带 7-Zip 二进制，插件安装和打包不要求目标机器另装 7-Zip。不要随意替换
`third_party/7zip/` 中的文件；发布前运行 `tools/verify-third-party.ps1` 校验版本与
SHA-256。

## 3. 首次获取与构建

### Windows 自动探测

```powershell
git clone https://github.com/WintreeBaka/McServerManager.git
cd McServerManager
.\scripts\build-windows.ps1
```

脚本会探测 Qt 套件、对应的 MinGW、Ninja 和 CMake，并把运行时目录加入当前进程的
`PATH`。默认产物：

```text
build\bin\mcsm-cli.exe
build\bin\McServerManager.exe
```

明确指定套件并可生成便携运行时：

```powershell
.\scripts\build-windows.ps1 -QtDir "C:\Qt\6.8.3\mingw_64" -Deploy
```

重新配置：

```powershell
.\scripts\build-windows.ps1 -QtDir "C:\Qt\6.8.3\mingw_64" -Reconfigure
```

`-Reconfigure` 会删除构建目录，因此目录中必须存在 `.mcsm-managed` 标记，且不能是
盘符根目录或系统敏感目录。旧版本创建的 `build/` 可能没有标记；此时应使用新的
`-BuildDir build-new`，确认旧目录内容后自行决定是否清理。

### Linux / macOS

```bash
./scripts/build-unix.sh /path/to/Qt/6.8.3/gcc_64
```

### 手动构建

```bash
cmake -S . -B build \
  -DCMAKE_PREFIX_PATH=/path/to/Qt/6.8.3/gcc_64 \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
```

CMake 是版本的唯一来源。`CMakeLists.txt` 中的 `project(... VERSION ...)` 会注入
`MCSM_VERSION` 供两个程序显示；发布脚本也读取同一字段。升级版本时不要在多处手写版本号。

## 4. 运行与隔离开发数据

先直接运行后端，确认程序可启动：

```powershell
.\build\bin\mcsm-cli.exe version
.\build\bin\mcsm-cli.exe doctor
```

开发时应使用独立数据根，避免污染日常数据：

```powershell
$devHome = Join-Path $env:TEMP "mcsm-dev"
.\build\bin\mcsm-cli.exe --home $devHome version
```

```bash
mcsm-cli --home /tmp/mcsm-dev version
```

启动界面：

```powershell
.\build\bin\McServerManager.exe
```

界面查找后端的顺序包括同级目录、`backend/`、`bin/`、`build/bin/` 和 `PATH`。也可在
“设置 → 运行环境”中指定，或在当前进程设置 `MCSM_BACKEND`。后端数据根优先级为：
`--home`、`MCSM_HOME`、系统默认目录。

不要提交开发数据。`servers.json` 含 RCON 凭据，配置备份、世界备份、容器包和日志
也可能包含敏感信息。

## 5. 源码导航

```text
backend/src/
  cli/       参数解析与命令路由
  core/      路径、JSON、日志、进程运行、归档
  net/       HTTP、版本解析
  docker/    Docker 命令与模板文件
  java/      JDK 镜像与本机 JDK
  server/    记录、安装、生命周期、RCON
  config/    server.properties 结构与安全写入
  backup/    备份、恢复和保留策略
  plugin/    插件包、运行时与钩子
  schedule/  定时任务守护进程

frontend/src/
  app/       全局上下文、主题、后端客户端、共享常量
  model/     服务器数据模型
  plugin/    QJSEngine 插件宿主与 mcsm.* API
  ui/        主窗口、标题栏、导航、Toast
  widgets/   动画、日志、卡片和通用控件
  pages/     业务页面与插件页面渲染

plugins/official/   官方管理器插件
examples/plugins/   可用于开发和打包的示例插件
tools/              检查、冒烟测试、打包与发布脚本
scripts/            跨平台/分平台构建入口
packaging/          发行包内快速上手文本
```

## 6. 测试矩阵

### 每次提交前

```powershell
python tools/static_check.py
.\build\bin\mcsm-cli.exe version
.\tools\smoke-test.ps1 -Exe .\build\bin\mcsm-cli.exe
```

`smoke-test.ps1` 不要求 Docker，覆盖协议信封、服务器安装/校验、配置、备份、插件包、
RCON 安全边界、损坏记录保护和版本一致性。需要明确运行库时可传入：

```powershell
.\tools\smoke-test.ps1 `
  -Exe .\build\bin\mcsm-cli.exe `
  -QtBin "C:\Qt\6.8.3\mingw_64\bin" `
  -MinGwBin "C:\Qt\Tools\mingw1310_64\bin"
```

### 修改 UI 后

```powershell
.\tools\gui-smoke.ps1 -Screenshot .\build\gui-smoke.png
```

该脚本会启动真实窗口、确认主窗口可见、等待应用稳定、截图并检查退出后是否遗留后端。
布局回归可追加 `-Page settings-runtime -Resize 1100x700`。

### 修改插件后

```powershell
node --check plugins\official\container-porter\backend\index.js
node --check plugins\official\player-admin\backend\lib\mcsm.js
.\plugins\build-plugins.ps1
```

同时至少安装并调用一次受影响插件：

```powershell
.\build\bin\mcsm-cli.exe --home $devHome plugin package inspect --zip .\dist\plugins\<plugin>.zip
.\build\bin\mcsm-cli.exe --home $devHome plugin package install --zip .\dist\plugins\<plugin>.zip --grant ui.pages,servers.read
.\build\bin\mcsm-cli.exe --home $devHome plugin call --name <plugin-id> --method <method>
```

### 依赖或发布脚本改动后

```powershell
.\tools\verify-third-party.ps1
python tools\check-endpoints.py
```

上游 API 探针需要网络，不应当把临时网络故障当成代码失败；正式发布前仍应确认涉及的
下载源可用。

## 7. 常见开发任务

### 7.1 增加后端命令

1. 在 `backend/src/cli/ArgParser` 中补充参数读取。
2. 在 `CommandRouter::dispatch` 中路由到明确的方法。
3. 业务逻辑放在对应服务中，返回统一的 `Result` JSON 信封。
4. 所有错误提供稳定错误码、可读消息和必要的处理建议。
5. 更新 `docs/CLI.md`、`docs/PROTOCOL.md`，并在 `tools/smoke-test.ps1` 增加成功与失败用例。
6. 确认 `--json` 不混入调试输出；调试信息写 `Logger`。

业务层不能依赖 GUI；后端必须能单独运行。涉及文件写入时要在锁内完成，涉及外部进程时
优先复用 `ProcessRunner`，避免各自实现超时、PID 和平台分支。

### 7.2 增加界面页面或交互

1. 页面继承现有 `PageBase`，把左侧菜单放入 `setSideColumn()` 的固定列。
2. 通过 `BackendClient` 发起异步请求，不在 UI 线程中执行阻塞命令。
3. 检查 `reply.ok`；失败必须显示到状态标签、横幅或日志，不能静默留白。
4. 长时间列表、日志、插件输出必须有上限；高频刷新使用防抖。
5. 新尺寸、间隔和数量阈值优先放到 `frontend/src/app/Constants.h`。
6. 在主题切换、窗口缩放和快速切页后检查布局、颜色和对象生命周期。

界面中文文本使用 `QStringLiteral`，不要用 `QLatin1String` 包裹非 ASCII 内容。

### 7.3 增加 `server.properties` 字段

配置字段定义集中在 `ConfigSchema`，解析与保留原文的逻辑在 `ConfigManager`。新增字段时：

- 提供类型、默认值、选项和说明；
- 不破坏注释、空行和未知键；
- 保存前生成配置快照；
- 为异常值、空值、未知选项和回滚增加测试；
- 检查界面编辑器对未知现有值是否仍能原样保留。

### 7.4 开发管理器插件

插件开发的完整字段和 API 以 `docs/PLUGIN-SDK.md` 为准。最稳妥的起步方式是复制
`examples/plugins/hello-panel` 或 `examples/plugins/ops-console`。

基本流程：

```powershell
.\plugins\build-plugins.ps1
.\build\bin\mcsm-cli.exe --home $devHome plugin package inspect --zip .\dist\plugins\<plugin>.zip
.\build\bin\mcsm-cli.exe --home $devHome plugin package install --zip .\dist\plugins\<plugin>.zip
.\build\bin\mcsm-cli.exe --home $devHome plugin call --name <plugin-id> --method <method>
```

关键规则：

- 插件包只能把文件放在管理器数据目录内，拒绝绝对路径、`..`、符号链接和硬链接越界。
- 1.3.0 起插件必须声明 `apiVersion: 2`，API 1 包只在管理页显示但不能执行。后端只支持
  Node.js，且安装时默认零权限；开发和测试时显式传入 `--grant`，不要使用 `--grant-all`
  掩盖缺失的权限边界。
- `permissions` 是声明即契约：清单中没有的权限不能授权；新增权限在升级时默认不勾选。权限被
  撤销后，插件必须处理 `PERMISSION_DENIED`，并通过通知和日志让用户知道哪个功能失效。
- 前端插件运行在 `QJSEngine` 中，没有原生文件或进程能力，只能调用 `mcsm.*`。
- 后端插件是独立 Node.js 进程，一行 JSON 请求、一行 JSON 响应；单行输入有大小上限。
  默认只能读写插件目录与私有数据，服务器目录和子进程能力必须逐项授权。
- 插件不得直接写 `servers.json`。需要注册服务器时调用受控的
  `mcsm-cli server register --file <record.json>`，由管理器完成校验与事务写入。
- 插件只能访问自身数据目录；涉及服务器目录时必须验证真实路径位于 `<root>/servers` 下。
- 在线模式下不得猜测离线 UUID；RCON 不可用时不要直接改玩家文件。
- 修改协议或 `mcsm.*` API 时同步更新 SDK、示例、版本兼容说明和插件冒烟测试。

测试插件权限时至少覆盖：零权限安装、逐项授权、撤销权限、升级新增权限默认关闭、未知/未声明
权限拒绝、API 1 阻止执行、未授权的服务器目录读取和 `child_process` 访问失败，以及拒绝信息同时
出现在后端日志和界面通知中。详细说明见 `docs/PLUGIN-SDK.md` 第 8 节。

### 7.5 修改进程或容器生命周期

使用 `ProcessRunner` 的统一能力，不要在模块中再写一套 `tasklist`、`/proc` 或
`taskkill` 逻辑。检查以下约束：

- PID 可能被系统复用，不能只看“进程存在”；
- 重要进程要同时核对可执行映像和命令行特征；
- POSIX 超时要终止整个子进程组；
- Windows 使用进程树终止并设置超时；
- 递归启动外部进程必须有深度保护；
- 端口开放不等于本程序拥有的进程正在运行。

## 8. 并发、数据与安全约束

### `servers.json` 单写者

`ServerStore` 使用进程内互斥量和文件锁覆盖“重新读取 → 修改 → 写回”的完整事务。
不要在其他模块中读取后直接追加 JSON。需要外部导入时使用：

```powershell
.\build\bin\mcsm-cli.exe --home $devHome server register --file .\record.json
```

### 路径边界

- 服务器目录必须是 `<root>/servers` 下的真实子路径。
- `jarName` 只能是纯文件名，不能包含目录分隔符或 `..`。
- 插件、备份和压缩包解压要拒绝路径穿越、特殊链接和过大条目。
- 递归删除脚本必须检查根目录、敏感目录和 `.mcsm-managed` 标记。

### 凭据

- 不在日志、异常详情、测试输出或发布说明中输出 RCON 密码、访问令牌或完整认证包。
- 发布令牌只放环境变量或认证头，不放进命令行参数。
- `servers.json`、配置备份、世界备份和容器包按敏感资产处理。

### 异步与资源上限

- 插件脚本和异步回调必须有执行预算与隔离。
- 流式输出要限制单行、缓冲区和 pending 行数。
- 高频日志、过滤和页面重建要使用防抖。
- 对象结束、失败启动和超时路径都要释放 QProcess/QObject。

## 9. 调试

### 后端

```powershell
.\build\bin\mcsm-cli.exe --verbose --home $devHome doctor
```

诊断日志默认写到 `<数据根>/logs/backend.log`，采用 JSON Lines，并按大小轮转。
`warn` 和 `error` 会立即刷盘，普通日志按批次写入；命令行模式退出前会显式 flush。

检查协议输出时不要只看退出码，还要确认最后一行是完整 JSON 信封，流式命令的中间行是
合法 NDJSON。

### 界面

- 确认 `McServerManager.exe` 实际找到的是哪个 `mcsm-cli`。
- 在“设置 → 运行环境”查看后端路径与数据目录。
- 使用 `tools/gui-smoke.ps1 -Screenshot` 保存真实窗口截图。
- 查看后端日志和界面状态，不要仅根据按钮状态判断请求成功。

### 插件

- 先 `plugin package inspect` 校验包结构和作用域。
- 使用独立 `--home` 安装，避免影响已有插件数据。
- 后端插件先直接运行 `node --check`，再看插件进程的标准错误。
- 前端脚本异常应显示在插件页面或全局通知中；同时检查是否触发看门狗。

## 10. 代码约定

- C++17，命名空间 `mcsm`，四空格缩进。
- 头文件与源文件同名；新增源码要同步加入对应 `CMakeLists.txt`。
- 优先使用 Qt 容器、JSON 和设备类；错误沿调用链明确返回。
- 用户可见中文用 `QStringLiteral`；注释可保持现有中英混合风格。
- 不把绝对盘符、个人目录或测试令牌写进源码、脚本和文档。
- 新依赖需要说明用途、许可、来源、完整性校验和维护成本。
- 公共常量集中管理；不要在多个文件重复定义超时、上限和动画时长。
- 修改协议、文件格式或兼容范围时，必须同步版本、文档和测试。

提交前检查：

```powershell
git diff --check
python tools\static_check.py
.\tools\smoke-test.ps1 -Exe .\build\bin\mcsm-cli.exe
```

## 11. 构建与发布发行包

发行版本以 CMake `project(VERSION)` 为准。发布前确认 `CHANGELOG.md` 和
`docs/RELEASE_NOTES-<Version>.md` 已更新。

```powershell
.\scripts\build-windows.ps1 -QtDir "C:\Qt\6.8.3\mingw_64" -Deploy
.\plugins\build-plugins.ps1
.\tools\package-release.ps1
.\tools\package-release.ps1 -Flavor cli
```

发行产物通常包括：

```text
dist\McServerManager-<Version>-win64.zip
dist\McServerManager-<Version>-win64.zip.sha256
dist\McServerManager-<Version>-win64-cli.zip
dist\McServerManager-<Version>-win64-cli.zip.sha256
dist\plugins\com.mcsm.player-admin-1.1.0.zip
```

发布前验证：

```powershell
.\tools\verify-third-party.ps1
python tools\static_check.py
.\tools\smoke-test.ps1 -Exe .\build\bin\mcsm-cli.exe
.\tools\gui-smoke.ps1 -Screenshot .\build\gui-smoke-release.png
Get-FileHash .\dist\McServerManager-<Version>-win64.zip -Algorithm SHA256
```

Git 推送与 Release 创建是不同步骤：先提交并推送代码和标签，再运行
`tools/create-release.ps1` / `tools/create-gitea-release.ps1` 上传附件。令牌只通过
环境变量传入；发布后检查两个远端的标签、发行说明、附件和 SHA-256 文件是否齐全。

## 12. 提交前自检清单

- 版本号只改在 CMake 的单一来源，并同步更新发行说明/变更日志。
- 新源码、头文件和资源已加入 CMake。
- UI 加载失败有可见错误，异步请求不阻塞主线程。
- 所有新列表、日志和流式缓冲都有上限。
- 文件访问经过真实路径边界检查，`servers.json` 没有绕过 `ServerStore`。
- 外部进程使用 `ProcessRunner`，PID 判断同时核对映像/命令行。
- 插件没有输出或记录凭据，也没有把令牌放进命令行。
- `git diff --check`、静态检查、后端冒烟、相关内容专项测试通过。
- 涉及界面时查看截图；涉及容器时在不破坏用户数据的环境完成端到端验证。
- `修复计划/`、构建目录、分发目录、开发数据和日志没有被提交。
