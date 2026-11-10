# 更新日志

## 1.1.4

界面缺陷修复，无接口与数据格式变更。

### 通知（Toast）

* **右侧被裁切**：通知卡片里的较长中文不再把卡片撑得比 320px 通知条更宽；
  窗口缩放后通知条也会重新贴回右上角，不再停在旧位置被窗口边缘切掉。
* **两条变三条**：卡片位置完全交给布局管理（入场/退场只做淡入淡出），
  两条通知同时到达时不会再互相重叠成“多出来的一条”；
  同一条消息在 700ms 内重复到达会被合并成一条。

### 配置 / 备份页

* 「配置备份」与「备份列表」的「刷新」按钮现在有可见反馈：点击后先显示“正在刷新…”，
  完成后显示条数；未选服务器或刷新失败都会给出明确提示，不再静默无响应。
* 配置备份行的「回滚到此版本」按钮不再被裁掉下半截：行高改为按行的实际宽度测量
  （备注文字会换行），列表宽度或窗口尺寸变化时都会重新排版。
* 备份页进入时先同步当前服务器 ID，避免刷新应答被“服务器已切换”的判断丢弃。
* 「关于」卡片改为读取程序实际版本号，不再硬编码 1.0.0。

## 1.1.3

按 2026-11-08 代码质量审计报告修复的高/中风险问题。

### 数据安全与正确性（H1/H4/M3/M4/M5/M7/L5/L9）

* **H1**：对运行中的 Docker 服务器再次 `start` 不再 `docker rm -f` 重建容器，
  而是返回“服务器已在运行”；`restart` 才是重启。`DockerManager::runContainer` 也加了同样防线。
* **H4**：配置页加载/保存都绑定发起时的 serverId：过期应答直接丢弃；
  有未保存修改时重新进入同一服务器不会覆盖编辑器，切换服务器会先确认。
* **M3**：游戏/RCON 端口统一校验（范围、两者不能相同、不能与任何服务器的 port/rconPort 重叠），
  安装与 `server update` 都走同一校验；显式传入重复端口会被拒绝。
* **M4**：`servers.json` 写入加 `QLockFile`；解析失败不再清空内存，
  而是备份为 `servers.json.broken-<时间>` 并让 `server list` 返回 `STORE_CORRUPT`；
  写盘失败会回滚内存修改（L5）。
* **M5**：`docker inspect` 失败与“容器不存在”区分开；查询失败时状态为 `unknown`，
  `stop` 返回 `DOCKER_UNAVAILABLE` 而不是假装已停止。
* **M7**：`registry.json` 损坏时备份并从 `plugins/` 目录重建；插件安装改为
  “临时目录 + rename”事务式替换；卸载先写注册表，写失败则不删除目录。
* **L9**：备份 `save-off` 期间写 `save-suspended` 标记；若进程崩溃，
  下一次备份会先补发 `save-on`，避免服务器永久停止落盘。

### 信任边界（H2/M1/M2/M6/M9/M16）

* **H2**：服务器插件 jar 文件名白名单（`[A-Za-z0-9._-]+.jar`），并用
  `Archive::isInside` 复核目标必须位于 `plugins/`；`--file`、启用/删除同样校验。
* **M1**：本机 JDK 模式的启动脚本对 memory（`^[0-9]+[MG]$`）、jar 名与 JVM 参数做白名单过滤，
  拒绝 shell 元字符，避免 `& calc` / `; rm` 之类的命令注入。
* **M2**：`server.properties` 写入前拒绝含换行的值与非法键；
  ConfigManager / TemplateWriter 全部改用 `QSaveFile` 原子提交并检查写入字节数。
* **M6**：下载只在最终 2xx 响应时写文件，重定向的 HTML body 不再污染 jar；
  下载完成后校验 zip/jar 魔数，损坏文件会被删除而不是“安装成功”。
* **M9**：压缩包条目列表读取失败时**拒绝解压**（fail-closed），不再跳过 zip-slip 校验。
* **M16**：备份恢复改为“把当前数据移到回滚目录 → 解压 → 成功才删除回滚目录”，
  解压失败自动回滚；zip 恢复改用 7-Zip/tar 参数数组，不再拼接 PowerShell 字符串。

### 异步 UI 与解耦（H3/M10/M11/M12/M13/M14/M15/L2/L3）

* **H3**：前端插件回调携带引擎代际与 `QPointer`，重新加载插件后在途回调被丢弃，消除 UAF。
* **M10**：`backend.timeoutMs` 真正生效（实测 200ms → `PLUGIN_TIMEOUT`）。
* **M11**：插件服务记录进程映像名，PID 被复用时不会误杀无关进程；
  `service.json` 写入失败时终止刚启动的服务；停止失败返回错误。
* **M12**：服务器详情 / 备份列表 / 服务器插件列表 / 搜索结果均绑定 serverId，过期应答被丢弃。
* **M13**：日志流结束/异常会发出 `streamFinished`，控制台提示断开并在返回页面时重连。
* **M14**：轮询加在途标记与请求序号，慢 Docker 下不会叠加请求或用旧快照覆盖新状态。
* **M15**：安装期间禁止关闭新建对话框；对话框销毁时主动终止后台命令并清理活动表。
* **L2/L3**：守护进程启动/退出、日志流停止不再在 UI 线程 `waitForStarted/Finished`。

### 界面与代码质量（L1/L4/L6）

* 仪表盘“运行环境”卡片在加载态为每行设置最小高度，修复文字重叠/小窗口裁切。
* 日志“跟随输出”在高频输出时不再逐行重启动画，改为复用运行中的动画。
* 清理 6 条编译警告（2 处 shadow、未使用的 `toJs()` 等）。

### 发布物

* 自 1.1.3 起每个 Release 同时提供两种包：
  * `McServerManager-<版本>-win64.zip`：含 GUI 的便携版；
  * `McServerManager-<版本>-cli-win64.zip`：纯 CLI 精简版（仅 Qt Core/Network，约 6.5 MB）。
* `tools/package-release.ps1` 新增 `-Flavor cli`；`packaging/QUICKSTART-CLI.txt` 为 CLI 版上手说明。

## 1.1.2

### 首个官方插件：玩家管理（player-admin）

* 源码：[`plugins/official/player-admin`](plugins/official/player-admin/)，作用域 `global`（前端页面 + 后端）。
* 页面：白名单 / 封禁 / OP 名单用表格展示；在线玩家与已知玩家按「一人一行」排列操作按钮，
  不再需要在成排按钮里横向找玩家。
* 操作：踢出、封禁、解封、设为 / 取消 OP、加入 / 移出白名单、开启 / 关闭 / 重载白名单、
  发送标题（含副标题）、私信、切换游戏模式、击杀、全服广播。
* 数据来源：服务器运行时走 RCON（服务端自己写名单，正版 UUID 正确）；
  未运行时退化为直接写 `whitelist.json` / `ops.json` / `banned-players.json` 并给出提示。
* 文案：标题、踢出/封禁理由、私信内容放在插件数据目录的 `texts.json`，改完约 20 秒生效。
* 打包：`plugins/build-plugins.ps1` 输出到 `dist/plugins/`，可直接在「设置 → 插件扩展」导入。

### 界面

* 插件页面按钮现在支持 `buttons.items[].level`：`primary`（默认）/ `outline`（可写 `ghost`）/
  `soft` / `danger`。此前所有插件按钮固定为半透明 Soft，深色主题下看起来像禁用状态。
* `docs/PLUGIN-SDK.md` 同步说明按钮色调取值。

### 插件安全与兼容

* 玩家名只允许 `A-Za-z0-9_`（1–16 位），理由 / 标题 / 私信会去掉换行并限制长度，
  防止通过 RCON 拼接执行第二条指令。
* 修复插件在 Windows 上没有管理器传入路径时使用 Roaming 目录的问题（改为 `LOCALAPPDATA`）。
* `player-admin` 声明 `minManagerVersion: 1.1.2`（1.1.1 可运行，但按钮色调不完整）。

### 测试

* `tools/smoke-test.ps1` 增加「官方插件包必须有效」用例：**68 项全部通过**。
* 实测官方插件：包校验 `global` + `apiVersion 1`；`health` / `dashboard` / `act` 离线写名单；
  非法玩家名与换行注入均被拒绝；本机安装后页面正常渲染。

## 1.1.1

### 接口版本（apiVersion）改为整数区间

* `apiVersion` 现在是**整数**：管理器每增加一批新接口 `+1`。
* 管理器维护 `SUPPORTED_MIN_API` / `SUPPORTED_MAX_API`（当前均为 `1`）：
  插件的 `apiVersion` 不在区间内会**拒绝加载**，日志与界面写明原因。
* 破坏性变更时抬高 `SUPPORTED_MIN_API`，旧插件自然淘汰，而不是行为异常。
* `minManagerVersion` 只作为**用户可见的提示**（版本偏低时给出警告），不参与硬校验。
* 兼容：写成字符串 `"1"` 仍能加载，但会提示改成整数；示例插件已改为整数写法。
* `mcsm-cli plugin api` 现在输出 `apiVersion`（整数）、`supportedMinApi`、`supportedMaxApi`、
  `managerVersion`、`apiVersionPolicy` 与 `security` 策略块。

### 安全：插件只能装在管理器目录里

* 安装目标必须位于 `<数据目录>/plugins/` 之内，越界直接拒绝（`UNSAFE_PLUGIN_PATH`）。
* 解压前扫描压缩包条目：**绝对路径 / 盘符 / UNC / `..` 跳出目录**全部拒绝（zip-slip 防护）。
* 解压后逐个校验落盘路径仍在插件目录内，并拒绝符号链接。
* `frontend` / `backend` / `web` 入口与 `web.service` 必须是包内相对路径；
  后端入口与前端 `mcsm.include()` 都会展开真实路径再校验，防止借助 `..` 或链接执行外部程序。

### 界面性能与"不互相拖死"

* 页面切换不再对整页做 `grab()` 快照，连点菜单时直接瞬切（不再逐帧动画）——这是卡顿的主因。
* 窗口背景（渐变 + 两团柔光）改为缓存位图，只在尺寸/主题变化时重绘。
* 页面激活时的刷新全部**节流**：`doctor`（会调用 docker CLI）4 秒内不重复执行，
  各页面列表/详情 1.5–2.5 秒内不重复拉取；后台页面不再因轮询而重建控件。
* 修复信号连接泄漏：设置页每次进入都会再连一次 `environmentChanged`，环境更新被重复执行 N 次。
* 服务器列表在内容未变化时不再触发模型信号（轮询不再引起全界面重建与重绘）。
* 隐藏页面会释放资源：控制台页离开 5 秒后停止 `docker logs --follow`；服务器页隐藏时不重建列表。
* 插件前端脚本加**看门狗**：加载 2500ms / 单次事件 1000ms 预算，超时强制中断并临时停用该插件；
  插件拿到的服务器列表改为缓存快照，消除"插件一调用就卡住整个窗口"的同步等待。
* 后端异步请求加看门狗（15 分钟兜底），杜绝"一条命令卡住 → 回调永不返回 → 该功能永久卡死"。
* 定时备份守护进程带 `--parent-pid`：管理器被强杀后守护进程自动退出，不再残留孤儿子进程。

### 实测（12 逻辑核，快速轮切 7 个页面）

| 场景 | 1.1.0 | 1.1.1 |
| --- | --- | --- |
| 空闲 | 0.29% | **0.03%** |
| 120ms 间隔轮切（53 次） | 2.20% | **1.15%** |
| 60ms 间隔轮切（95 次） | 2.91% | **1.76%** |

新增 `tools/ui-perf.ps1` 复现上述数据；`tools/smoke-test.ps1` 增加 10 项安全 / apiVersion 回归（共 67 项）。

## 1.1.0

### 新增：管理器插件包（Plugin SDK）

* **插件导入**：设置 → 插件扩展 → 添加插件，支持**本地 zip** 与 **URL** 两种来源，
  导入前先校验并展示识别到的作用域。命令行等价入口为 `mcsm-cli plugin package install|inspect`。
* **内置 7-Zip**：解压使用随程序发布的 `third_party/7zip/7za.exe`，目标机器不需要安装任何压缩软件
  （缺失时回退系统 7-Zip / tar）。7-Zip 的 LGPL 许可文本随包分发。
* **作用域自动识别**：按 `plugin.json` 的 `scope` 或目录结构自动判定
  `frontend` / `backend` / `web` / `global`，识别失败会拒绝导入并给出原因。
* **前端扩展接口**：`QJSEngine` 宿主 + `mcsm.*` API
  （`ui.registerPage` / `ui.setPageContent` / `toast` / `storage` / `settings` / `servers` /
  `backend.invoke` / `events.on` / `include`），页面由
  `heading / text / keyvalue / table / buttons / log / html / divider / progress` 区块描述，
  自动跟随主题、字体与配色；插件页面会出现在左侧主菜单中。
* **后端扩展接口**：独立进程 + **JSON-Line** 协议，支持 `node` / `python` / `java` / `exec` /
  `auto` 运行时与超时保护；钩子覆盖 `plugin.install|enable|disable|uninstall`、
  `server.beforeStart|afterStart|beforeStop|afterStop|beforeBackup|afterBackup|configApplied`、
  `scheduler.tick`，并支持 `server.*` 通配。
* **性能优化类插件**：`server.beforeStart` 可返回启动补丁
  （`jvmArgs` / `env` / `dockerArgs` / `note`，或用 `cancel` + `reason` 阻止启动），
  合并结果写入 `<服务器目录>/.mcsm/start-patch.json` 并在容器参数与生成的启动脚本中生效；
  停用插件后补丁自动清除。
* **支持库 / Web 面板类插件**：`plugin service start|stop|status` 管理插件自带的本地 HTTP 服务，
  注入 `MCSM_PLUGIN_ID` / `MCSM_PLUGIN_DIR` / `MCSM_PLUGIN_DATA` / `MCSM_PLUGIN_PORT`，
  界面上的「打开面板」按钮可一键启动并打开浏览器。
* **接口文档**：新增 `docs/PLUGIN-SDK.md`（包结构、`plugin.json` 全字段、前后端 API、钩子与补丁、
  权限说明、版本兼容、调试方法、命令速查），并可随时用 `mcsm-cli plugin api` 导出机器可读清单。
* **示例插件**：`examples/plugins/hello-panel`（前端）、`perf-tuner`（后端）、`ops-console`（全局 + Web 面板），
  以及打包脚本 `examples/plugins/build-examples.ps1`。

### 改进

* 数据根目录（`--home` / `MCSM_HOME`）现在始终解析为绝对路径，注册表与插件路径不再依赖当前工作目录。
* `Json::parseObject` 兼容带 UTF-8 BOM 的 JSON（Windows 工具与 PowerShell 写出的 `plugin.json` 可直接使用）。
* 设置页新增「插件扩展」分类（非实验性功能）。
* 界面深链接增加 `--page settings-plugins` / `extensions` / `settings-runtime`，并支持直接写插件页面 id。

### 测试

* `tools/smoke-test.ps1` 增加插件包回归：现场打包前端 / 后端 / 全局三种插件，
  覆盖「校验识别 → 安装 → 重复安装拒绝 → --force 覆盖 → 列表 → 后端 JSON-Line 调用 → 启停 → 卸载 → 非法包拒绝」。
* GUI 冒烟测试新增插件页面验证（`--page hello-panel`、`--page settings-plugins`）。

## 1.0.0

* 首个版本：Docker 化 JDK 运行环境、一键自动配置（Paper / Purpur / 原版 / Fabric）、
  控制台（日志 + RCON）、配置双模式与回滚、定时备份、Minecraft 插件市场、
  暗黑 / 亮色与渐变 / 纯色主题、贝塞尔过渡动画、字体预设、实验性本机 JDK 模式。
