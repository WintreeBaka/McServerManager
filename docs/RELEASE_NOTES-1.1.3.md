# McServerManager 1.1.3

1.1.3 按 **2026-11-08 代码质量审计报告**修复了全部 4 个高危问题与大部分中危问题，
重点是“别误杀运行中的服务器”“别丢配置/注册表”“插件安装与下载的信任边界”。

## 下载

| 文件 | 说明 |
| --- | --- |
| `McServerManager-1.1.3-win64.zip` | Windows 10/11 64 位**含 GUI 的便携版**（不需要安装 Qt 或 Java） |
| `McServerManager-1.1.3-win64-cli.zip` | **纯 CLI 精简版**（约 6.5 MB，只有 mcsm-cli.exe 与 Qt Core/Network，适合脚本/服务器/无桌面环境） |
| `PLUGIN-SDK.md` | 插件接口文档（单独附件，也随包放在 `docs/`） |
| `com.mcsm.player-admin-1.0.0.zip` | 官方插件「玩家管理」安装包 |

> 使用前请先安装并启动 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。
> 两个包共用同一数据目录（`%LOCALAPPDATA%\McServerManager`），可以只下载其中一个。

## 高危修复

| ID | 问题 | 1.1.3 行为 |
| --- | --- | --- |
| H1 | 对运行中的服务器再次 `start` 会 `docker rm -f` 重建 | 返回“服务器已在运行”；重建前也会二次检查容器状态 |
| H2 | 服务器插件文件名可越界写文件 | jar 文件名白名单 + `isInside` 复核，`--file` 同样校验 |
| H3 | 插件重载后在途回调访问已销毁引擎 | 引擎代际 + `QPointer` 校验，过期回调直接丢弃 |
| H4 | 配置页跨服务器串写、未保存修改被覆盖 | 请求绑定 serverId；未保存时阻止重载，切换服务器先确认 |

## 数据安全

* `servers.json` 写入加锁、损坏自动备份（`*.broken-<时间>`）并以 `STORE_CORRUPT` 报错，
  不再静默清空；写盘失败回滚内存。
* 端口统一校验：范围、游戏/RCON 不能相同、不能与任何服务器的端口重叠。
* `docker inspect` 失败不再当成“容器不存在”：状态显示 `unknown`，`stop` 返回错误。
* 插件注册表损坏会从 `plugins/` 目录重建；安装/升级改为事务式替换；卸载失败不再留下幽灵条目。
* 备份 `save-off` 中断会在下一次备份前自动恢复 `save-on`。

## 安全

* 本机 JDK 启动脚本对内存、jar 名、JVM 参数做白名单过滤，消除命令注入。
* `server.properties` 拒绝换行值/非法键，并使用 `QSaveFile` 原子写入。
* 下载只接受最终 2xx 内容，重定向 body 不再污染 jar；下载后校验 zip 魔数。
* 插件包解压要求条目列表读取成功（fail-closed）；插件 URL 默认必须 https
  （仅 localhost/127.0.0.1 允许 http 用于本地测试）。
* 备份恢复先移到回滚目录、成功后才删除，失败自动回滚；不再拼接 PowerShell 命令。

## 稳定性与性能

* 插件 `backend.timeoutMs` 真正生效（默认 30 秒，可被清单覆盖）。
* 插件服务校验进程映像名，PID 复用不会误杀无关进程。
* 服务器详情/备份/插件搜索等异步应答均绑定 serverId。
* 控制台日志流结束会提示并支持重连；轮询有在途保护，慢 Docker 不叠加请求。
* 安装期间不能关闭新建对话框；对话框销毁会终止后台任务。
* 守护进程启停与日志流停止不再阻塞 UI 线程；仪表盘加载态布局修复。

## 验证

* `tools/static_check.py`：106 文件 0 错 0 警。
* `tools/smoke-test.ps1`：68 项全部通过。
* 专项验证：
  * 非法/重复端口被拒绝（`PORT_IN_USE`）；
  * `servers.json` 损坏 → `STORE_CORRUPT` + `.broken-*` 备份；
  * `registry.json` 损坏 → 从插件目录恢复；
  * 插件 `timeoutMs=200` → 约 220ms 返回 `PLUGIN_TIMEOUT`。
* `tools/gui-smoke.ps1`：启动、拖拽、快速切页、截图通过。

## 已知未覆盖

* 审计报告中的 M17（本机模式 PID 复用/进程树跟踪）与 M18（CI 阻断式测试、单测/消毒器）
  仍待后续版本处理；当前 CI 的运行时冒烟仍是非阻断（镜像工具链 ABI 原因，见 workflow 注释）。
