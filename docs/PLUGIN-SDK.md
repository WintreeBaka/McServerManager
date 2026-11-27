# McServerManager 插件接口说明（Plugin SDK）

版本：**apiVersion 2** · 适用于 McServerManager 1.3.0 及以上

> **破坏性升级：McServerManager 1.3.0 不再执行 API 1 管理器插件。**
> 插件必须把 `plugin.json` 的 `apiVersion` 改为 `2`，并在 `permissions` 中按需声明能力。
> API 2 插件安装时默认**不授予任何权限**；用户可以在安装页和「插件管理」中逐项授权或撤销。
> 关闭权限后插件仍可能运行，但依赖该权限的功能会被拒绝，并在通知和日志中写出原因。

本文档描述 McServerManager 的**插件包（plugin package）**机制：如何打包、导入、启用，以及
前端（桌面界面）、后端（CLI 能力）、支持库 / Web 面板三类扩展分别可以调用哪些接口。

> 注意区分两个概念：
>
> * **Minecraft 插件**（Bukkit/Paper 的 `.jar`）：由「插件市场」页面管理，装进服务器的 `plugins/` 目录。
> * **管理器插件包**（本文档）：扩展 McServerManager 本身，给管理器加页面、加后端能力、加运维面板。
>
> 两者的命令都在 `mcsm-cli plugin` 下：前者是 `plugin search/install/list ...`（需要 `--id <服务器>`），
> 后者是 `plugin package ...`（全局，不需要服务器）。

---

## 1. 总览

```
                +----------------------- 插件包 (zip) -----------------------+
                |  plugin.json   frontend/    backend/    web/    README.md |
                +------------------------------------------------------------+
                                     |
   导入（本地 zip / URL） -> mcsm-cli plugin package install -> <数据目录>\plugins\<id>\
                                     |
                +--------------------+--------------------+
                v                                         v
     前端：QJSEngine 执行 frontend/index.js    后端：独立进程 + JSON-Line 协议
     （mcsm.* API -> 页面 / 表格 / 通知 / 调用） （钩子 + RPC -> 调优 / 服务 / 数据）
                |                                         |
                +---------- mcsm-cli 命令 / 事件 ----------+
```

| 作用域 | 含义 | 典型用途 |
| --- | --- | --- |
| `frontend` | 只扩展桌面界面 | 自定义面板、服务器看板、可视化统计 |
| `backend` | 只扩展后端能力 | JVM 调优、自定义生命周期钩子、数据采集 |
| `web` | 支持库 / Web 面板 | 自带本地 HTTP 服务，用浏览器访问的运维台 |
| `global` | 同时包含前端与后端 | 前端页面 + 后端数据接口的完整工具 |

作用域**不需要手工声明**：导入时管理器会扫描包内目录自动识别，也可以显式写在 `plugin.json` 里。

---

## 2. 快速开始

```powershell
# 1) 打包：把插件目录压成 zip（也可以用任意压缩工具，只要 zip 里能读到 plugin.json）
powershell -File examples\plugins\build-examples.ps1

# 2) 预览：只校验不安装，输出识别到的作用域
build\bin\mcsm-cli.exe plugin package inspect --zip dist\plugins\com.example.hello-panel-1.0.0.zip

# 3) 安装（默认零权限；--grant 只授予用户确认过的能力）
build\bin\mcsm-cli.exe plugin package install --zip dist\plugins\com.example.hello-panel-1.0.0.zip --grant servers.read
build\bin\mcsm-cli.exe plugin package install --url https://example.com/my-plugin-1.0.0.zip --force --grant ui.pages,servers.read

# 也可以稍后修改权限；--grant "" 表示撤销全部授权
build\bin\mcsm-cli.exe plugin package permissions --name com.example.hello-panel --grant ui.pages,servers.read

# 安全：插件包 URL 必须使用 https；仅 localhost / 127.0.0.1 允许 http（本地测试）

# 4) 查看 / 启停 / 卸载
build\bin\mcsm-cli.exe plugin packages
build\bin\mcsm-cli.exe plugin package info --name com.example.hello-panel
build\bin\mcsm-cli.exe plugin package disable --name com.example.hello-panel
build\bin\mcsm-cli.exe plugin package remove  --name com.example.hello-panel

# 5) 调用插件的后端方法 / 手动触发钩子
build\bin\mcsm-cli.exe plugin call --name com.example.ops-console --method summary
build\bin\mcsm-cli.exe plugin hook --all --hook server.afterStart --payload "{\"server\":{\"id\":\"demo\"}}"
```

图形界面里的等价入口：**设置 -> 插件扩展 -> 添加插件**（本地 zip / URL 两个来源）。
安装后左侧菜单会自动出现插件注册的页面。

---

## 3. 插件包结构

```
my-plugin-1.0.0.zip
+-- plugin.json            必需，插件清单（见第 4 节）
+-- README.md              建议提供
+-- frontend/              前端部分（可选）
|   +-- index.js           入口脚本，由 QJSEngine 执行
+-- backend/               后端部分（可选）
|   +-- index.js           API 2 入口脚本（只支持 Node.js）
+-- web/                   支持库 / Web 面板静态资源（可选）
    +-- index.html
```

* 包内允许有一层顶层目录（例如资源管理器“压缩文件夹”产生的 `my-plugin/plugin.json`），
  导入时管理器会自动向内查找 `plugin.json`。
* 只支持 **zip**。解压使用随程序发布的内置 7-Zip（`third_party/7zip/7za.exe`），
  目标机器**不需要**安装任何压缩软件；找不到内置副本时会回退到系统 7-Zip。
* 文件使用 UTF-8 编码；JSON 不要带 BOM。

---

## 4. `plugin.json` 完整字段

```json
{
  "id": "com.example.ops-console",
  "name": "运维面板",
  "version": "1.0.0",
  "apiVersion": 2,
  "minManagerVersion": "1.3.0",
  "scope": "global",
  "description": "一句话说明这个插件做什么",
  "author": "你的名字",
  "homepage": "https://github.com/you/my-plugin",
  "license": "MIT",
  "permissions": ["ui.pages", "servers.read"],

  "frontend": { "entry": "frontend/index.js" },
  "backend": {
    "entry": "backend/index.js",
    "runtime": "node",
    "args": [],
    "timeoutMs": 20000
  },
  "web": {
    "entry": "web/index.html",
    "service": "backend/server.js",
    "port": 18765,
    "title": "运维面板"
  },
  "hooks": ["server.beforeStart", "server.afterStart"],
  "contributes": {
    "pages": [
      { "id": "ops", "title": "运维面板", "icon": "op", "subtitle": "服务器总览" }
    ]
  }
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | 是 | 插件唯一标识，建议反向域名（`com.example.my-plugin`）。只允许 `A-Za-z0-9._-`，用作安装目录名 |
| `name` | 是 | 显示名称（支持中文） |
| `version` | 是 | 插件版本，如 `1.0.0` |
| `apiVersion` | 是 | **整数**接口版本（见 §4.3）；1.3.0 只接受 `2` |
| `minManagerVersion` | | 建议使用的管理器版本，**只提示用户，不参与硬校验** |
| `scope` | | `frontend` / `backend` / `web` / `global` / `auto`（默认 `auto`，即自动识别） |
| `description` / `author` / `homepage` / `license` | | 元信息，显示在插件列表里 |
| `permissions` | | 插件声明的能力契约（见第 8 节）。未知权限会使包校验失败；未在清单中声明的权限不能授权 |
| `frontend.entry` | | 前端入口脚本（相对插件根目录）。缺省时自动寻找 `frontend/index.js` |
| `backend.entry` | | 后端入口（脚本或可执行文件）。缺省时自动寻找 `backend/index.js`、`backend/main.py` 等 |
| `backend.runtime` | | API 2 必须为 `node`（或 `auto` 且入口为 `.js`）；其他运行时会被拒绝执行 |
| `backend.args` | | 追加到入口命令后的参数数组 |
| `backend.timeoutMs` | | 单次调用超时，默认 30000 |
| `web.entry` | | Web 面板静态页面（相对路径），缺省时自动寻找 `web/index.html` |
| `web.service` | | 需要常驻的本地服务入口（`plugin service start` 启动它） |
| `web.port` | | 服务端口，会作为环境变量 `MCSM_PLUGIN_PORT` 传入 |
| `web.title` | | 面板标题 |
| `hooks` | | 后端要接收的钩子名，支持 `server.*` 这类通配（见第 6.3 节） |
| `contributes.pages` | | 供界面预展示的页面清单（前端脚本仍应调用 `mcsm.ui.registerPage`） |

最小可用清单只需要 `id`、`name`、`version`，再加上至少一个入口。

### 4.1 作用域自动识别规则

1. 若显式写了 `scope`，以它为准（并校验对应入口是否存在）。
2. 否则按目录结构推断：

| 检测到的部分 | 识别结果 |
| --- | --- |
| 只有 `frontend/`（或 `frontend.entry`） | `frontend`（前端扩展） |
| 只有 `backend/` | `backend`（后端服务） |
| 只有 `web/` | `web`（支持库 / Web 面板） |
| `frontend/` + `backend/` | `global`（全局） |
| 任意两项以上 | `global` |

3. 识别不出内容、入口文件不存在、权限未知、或 `apiVersion` 超出支持区间：**拒绝导入**并给出具体原因。

**只装命令行的环境**：发行包 `McServerManager-<版本>-win64-cli.zip` 里只有 `mcsm-cli.exe`，
没有桌面界面。这类机器上 `frontend` / `web` / `global` 作用域的插件虽然也能安装、后端也能调，
但页面永远不会被打开 —— 实际使用请选 `scope: "backend"` 的插件
（例如「容器搬运工」的 CLI 版 `com.mcsm.container-porter.cli`）。

### 4.3 apiVersion：整数区间

`apiVersion` 是**整数**，不是语义化版本：管理器每增加**一批新接口**就 `+1`。

| 常量 | 含义 |
| --- | --- |
| `SUPPORTED_MIN_API` | 仍然支持的最老接口级别；1.3.0 为 `2` |
| `SUPPORTED_MAX_API` | 当前级别，等于管理器的 `apiVersion` |

* 插件的 `apiVersion` **不在 `[MIN, MAX]` 区间内 → 拒绝执行**。API 1 包仍会显示在插件管理中，
  以便用户升级或卸载，但状态会标记为“API 不兼容”。
* `apiVersion` 必须写成整数 `2`。字符串 `"2"` 会给出兼容警告；省略 `apiVersion` 按 1 处理并拒绝执行。
* `minManagerVersion` 只是给用户看的提示：管理器版本更低时给出警告，**不会**阻止插件加载。

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "apiVersion": 2,
  "minManagerVersion": "1.3.0"
}
```

当前级别可以用 `mcsm-cli plugin api` 查询：

```json
{
  "apiVersion": 2,
  "supportedMinApi": 2,
  "supportedMaxApi": 2,
  "managerVersion": "1.3.0",
  "apiVersionPolicy": {
    "type": "integer",
    "bumpOn": "每增加一批新接口 +1",
    "rejectWhen": "不在 supportedMinApi..supportedMaxApi 区间内",
    "minManagerVersion": "仅提示用户，不参与硬校验"
  }
}
```

> 导入对话框会先调用 `plugin package inspect`，并把识别结果（例如“识别为：全局（前端 + 后端）”）
> 显示给用户，确认后才会真正写入磁盘。

### 4.2 安装位置与数据目录

| 路径 | 说明 |
| --- | --- |
| `<数据目录>/plugins/` | 插件安装根目录（Windows 默认 `%LOCALAPPDATA%\McServerManager\plugins`） |
| `<数据目录>/plugins/<id>/` | 单个插件解压后的全部内容（含 `install.json` 安装记录） |
| `<数据目录>/plugins/registry.json` | 注册表：id、版本、作用域、启用状态、来源 URL、安装时间 |
| `<数据目录>/plugins/.data/<id>/` | 插件私有数据（卸载默认保留，加 `--purge-data` 才删除） |
| `<服务器目录>/.mcsm/start-patch.json` | 后端插件对本次启动生效的参数补丁（见第 6.4 节） |

---

## 5. 前端插件 API

前端脚本在 **QJSEngine**（ES2020，无 DOM、无 `require`）中执行，入口脚本运行时会拿到全局对象 `mcsm`。
脚本出错不会影响管理器本身，错误会显示在「设置 -> 插件扩展」页面的状态行。

### 5.1 全局对象

| 属性 | 说明 |
| --- | --- |
| `mcsm.version` | 管理器版本，如 `1.2.0` |
| `mcsm.apiVersion` | 当前接口级别（整数，1.3.0 为 `2`） |
| `mcsm.plugin.id / .name / .version / .scope / .path` | 当前插件信息 |

### 5.2 日志与通知

```js
mcsm.log("写入管理器日志");
mcsm.toast("存档完成", "success");     // level: info | success | warn | error
mcsm.openUrl("https://example.com");   // 仅允许 http/https，用系统浏览器打开
mcsm.utils.humanBytes(1536);           // -> "1.5 KB"
```

### 5.3 界面扩展（UI 扩展类插件）

```js
var pageId = mcsm.ui.registerPage({
  id: "my-page",          // 省略时自动生成
  title: "我的页面",
  icon: "S",              // 侧边栏图标（任意字符或 emoji）
  subtitle: "一句话说明"
});

mcsm.ui.setPageContent(pageId, [ /* 区块数组，见下表 */ ]);
mcsm.ui.openPage(pageId);   // 让管理器跳转到该页面
```

注册成功后：左侧主菜单会出现一个新条目（点击即可切换，沿用原有的动画过渡），
页面内容完全由 `setPageContent` 决定，主题、字体、配色会自动跟随用户设置（暗黑/亮色、渐变/纯色）。

**区块类型**（`setPageContent` 数组的元素）：

| type | 字段 | 效果 |
| --- | --- | --- |
| `heading` | `text` | 标题 |
| `text` | `text`, `style`(`hint` / `caption` / `subtitle`) | 段落文本 |
| `keyvalue` | `items: [["键","值"], ...]` 或 `[{key,value}]` | 键值表 |
| `table` | `title`, `columns: []`, `rows: [[...]]`；可选 `selectable: true`, `key`, `rowIds: []`, `selected: []` | 表格；`selectable` 时每行前带勾选框，并有「全选 / 全不选」 |
| `buttons` | `items: [{label, icon, command, action, pick, url, openUrlFrom, toast, level}]`，`level` 取 `primary`（默认）/ `outline`（可写 `ghost`）/ `soft` / `danger` | 按钮行 |
| `log` | `title`, `text` | 控制台风格输出框（按钮执行结果也会写进这里） |
| `html` | `html` | 富文本片段（Qt 富文本子集） |
| `divider` | 无 | 分隔线 |
| `progress` | `label`, `value`(0-100) | 进度条 |

`buttons` 的四种行为：

1. `command`：执行一条 mcsm-cli 命令（例如 `"server list"`、`"plugin call --name x --method y"`），
   结果写入同页面的 `log` 区块；
2. `url`：仅允许 http/https，直接用浏览器打开；
3. `openUrlFrom: "url"`：先执行 `command`，再从返回数据里取该字段作为 URL 打开
   （例如 `plugin service start` 返回的 `url`）。
4. `action: "名字"`：不执行命令，改为调用脚本里通过 `mcsm.ui.onAction` 绑定的回调
   （见 5.3.1），配合 `pick` 可以让用户先选文件/目录。

#### 5.3.1 交互式页面：勾选表格、按钮回调、选择路径

需要用户选择的页面（导出时要选保存位置、导入时要选文件）用这三个能力组合：

```js
var pageId = mcsm.ui.registerPage({ id: "my-page", title: "我的页面" });

// ① 按钮回调：点击时不跑命令，直接调脚本
mcsm.ui.onAction(pageId, "export", function (info) {
  // info = { pageId, action, path? }   ← path 是 pick 选出来的路径
  if (!info.path) return;                       // 用户取消了
  mcsm.backend.invoke(["plugin", "call", "--name", mcsm.plugin.id,
                       "--method", "export~" + encodeURIComponent(info.path)],
                      function (reply) { mcsm.log(JSON.stringify(reply.data)); });
});

// ② 按钮声明 action + pick：管理器先弹原生对话框，再回调
mcsm.ui.setPageContent(pageId, [{
  type: "buttons",
  items: [
    { label: "导出…", action: "export",
      pick: { mode: "auto", title: "导出到…", filter: "容器包 (*.tar)",
              defaultPath: "", defaultName: "备份.tar" } },
    { label: "导入…", action: "import",
      pick: { mode: "open", title: "选择容器包", filter: "容器包 (*.tar)" } }
  ]
}]);

// ③ 可勾选表格：勾选变化会触发 ui.selection 事件
mcsm.ui.setPageContent(pageId, [{
  type: "table", title: "服务器", columns: ["名称", "类型"],
  rows: [["主服", "paper"], ["测试服", "vanilla"]],
  selectable: true, key: "servers",
  rowIds: ["main", "test"],    // 与 rows 一一对应，作为选择结果里的 id
  selected: ["main"]           // 初始勾选（重绘时用它保持状态）
}]);
mcsm.events.on("ui.selection", function (payload) {
  // payload = { pageId, key, selected: ["main","test"], count: 2 }
});
```

`pick.mode` 取值：

| mode | 对话框 | 返回 |
| --- | --- | --- |
| `save` | 另存为 | 目标文件路径（可能不存在） |
| `open` | 打开文件 | 选中的文件路径 |
| `dir` | 选择文件夹 | 目录路径 |
| `auto` | 勾选 1 行时「另存为」，否则「选择文件夹」 | 文件或目录路径 |

对话框由管理器（C++ 侧）弹出，**不要在脚本里同步等待输入**；用户取消时回调仍会被调用，
只是 `info.path` 为空字符串。勾选表格的选择状态由页面视图维护，脚本重绘时通过
`selected` 传回来即可保持勾选。

### 5.4 服务器数据

```js
var servers = mcsm.servers.list();   // 缓存快照，立即返回，不会阻塞界面
var current = mcsm.servers.selected();
mcsm.refreshServers();               // 需要最新数据时再刷新（异步，刷新后触发 servers.refreshed 事件）
```

> `mcsm.servers.list()` **不会**去调用后端：它读取管理器已有的缓存，
> 因此即使后端很慢也不会卡住界面（旧版本会同步启动 `mcsm-cli`，一个插件就能让窗口卡住）。

### 5.5 调用后端

```js
mcsm.backend.invoke("server list", function (reply) {
  // reply = { ok, data, warnings, error, code }
  if (reply.ok) mcsm.toast("共 " + reply.data.count + " 台服务器", "info");
});

// 也可以传参数数组，避免转义
mcsm.backend.invoke(["plugin", "call", "--name", "com.example.ops-console", "--method", "summary"],
                    function (reply) { mcsm.log(JSON.stringify(reply.data)); });
```

所有 mcsm-cli 命令都可以这样调用，回调里的 `data` 就是命令输出的 `data` 字段。

### 5.6 事件订阅

```js
mcsm.events.on("servers.refreshed",   function (payload) { /* payload.count */ });
mcsm.events.on("server.selected",     function (payload) { /* payload.serverId */ });
mcsm.events.on("theme.changed",       function (payload) { /* payload.dark, payload.style */ });
mcsm.events.on("environment.changed", function (payload) { /* doctor 数据 */ });
mcsm.events.on("app.ready",           function (payload) { /* payload.pluginCount */ });
```

| 事件 | 触发时机 | payload |
| --- | --- | --- |
| `app.ready` | 所有前端插件加载完成后 | `{pluginCount}` |
| `servers.refreshed` | 服务器列表刷新成功 | `{count}` |
| `server.selected` | 用户切换当前服务器 | `{serverId}` |
| `environment.changed` | 环境自检（doctor）刷新 | doctor 结果 |
| `theme.changed` | 主题 / 配色切换 | `{dark, style}` |
| `ui.selection` | 可勾选表格（`selectable: true`）的勾选变化 | `{pageId, key, selected, count}` |

### 5.7 数据存储

```js
mcsm.storage.set("lastRun", Date.now());   // 插件私有（按插件 id 隔离）
mcsm.storage.get("lastRun");
mcsm.storage.keys();
mcsm.storage.remove("lastRun");

mcsm.settings.get("ui/theme");             // 读取管理器设置
mcsm.settings.set("pluginData/com.example.demo/flag", true); // 只能写自身数据前缀
```

### 5.8 多文件

前端没有模块系统，但可以用同步 `include` 拆分脚本：

```js
mcsm.include("frontend/util.js");   // 在同一个引擎里求值，可共享全局变量
```

### 5.9 完整前端示例

见 `examples/plugins/hello-panel/`（注册页面 + 表格 + 按钮 + 事件订阅）与
`examples/plugins/ops-console/frontend/index.js`（调用自己的后端方法 + 打开 Web 面板）。

---

## 6. 后端插件 API

### 6.1 运行时

后端插件由管理器**按需拉起独立进程**，通过 **JSON-Line 协议**通信：

1. 管理器把**一行 JSON 请求**写入插件进程的 stdin；
2. 插件把**一行 JSON 结果**写到 stdout（也可以先输出若干进度行）；
3. 进程退出，管理器读取结果。

因此插件与管理器彻底隔离：插件崩溃、死循环、缺少依赖都不会拖垮管理器，超时会被强制结束。

| `backend.runtime` | API 2 说明 |
| --- | --- |
| `node` | 唯一受支持的后端运行时；需要 PATH 里有支持 `--permission` / `--allow-fs-read` / `--allow-fs-write` 的 Node.js（推荐并测试 Node 24） |
| `auto` | 仅当入口是 `.js` 时解析为 Node.js |
| `python` / `java` / `exec` | **拒绝执行**；这些运行时没有统一的权限边界 |

缺少运行时或 Node.js 版本过旧时不会被静默忽略：`plugin package info` 会显示
`launchError`，界面也会提示。CI 固定使用 Node 24，插件开发者也应以 Node 24 做权限回归。

Node.js 后端进程由管理器附加 Node Permission Model 参数：默认只能读插件安装目录、读写自己的
数据目录。`filesystem.server.read` / `filesystem.server.write` 才会分别开放 managed servers 目录的
读取/写入；`process.spawn` 才会开放 `child_process`。管理器**不再**向 API 2 后端注入
`MCSM_BACKEND` 或 `MCSM_HOME`，插件不能借环境变量直接取得管理器控制通道。

可用的只读环境变量如下：

| 变量 | 含义 |
| --- | --- |
| `MCSM_PLUGIN_ID` | 当前插件 id |
| `MCSM_PLUGIN_DIR` | 插件安装目录 |
| `MCSM_PLUGIN_DATA` | 插件私有数据目录 |
| `MCSM_GRANTED_PERMISSIONS` | 本次运行已获授权限，逗号分隔 |
| `MCSM_MANAGER_VERSION` | 管理器版本 |

### 6.2 请求与响应格式

**请求**（管理器 -> 插件，一行 JSON）：

```json
{
  "apiVersion": 2,
  "plugin": "com.example.perf-tuner",
  "method": "server.beforeStart",
  "params": { "server": { "id": "survival", "memory": "16G" } },
  "caller": "mcsm-cli",
  "pluginsDir": "C:/Users/me/AppData/Local/McServerManager/plugins",
  "dataDir": "C:/Users/me/AppData/Local/McServerManager/plugins/.data/com.example.perf-tuner",
  "permissions": ["server.start.patch"],
  "requestedAt": "2026-10-08T20:58:14"
}
```

**成功响应**：

```json
{
  "ok": true,
  "data": { "memoryGb": 16 },
  "patch": { "jvmArgs": ["-XX:+UseZGC"], "note": "已应用 ZGC" },
  "warnings": ["可选提示"],
  "log": ["可选日志行"]
}
```

**失败响应**：

```json
{ "ok": false, "error": { "code": "METHOD_NOT_FOUND", "message": "未实现该钩子", "detail": "" } }
```

**进度行**（可选，可在结果之前输出任意多行）：

```json
{ "type": "log", "line": "正在收集指标" }
```

约定：

* 一行一个 JSON 对象，UTF-8 编码，一行内结束（不要美化换行）。
* 只有带 `ok` 字段的行被当作最终结果，出现多行时最后一行生效。
* 退出码非 0 且没有合法结果行时，管理器记录 `PLUGIN_PROTOCOL_ERROR` 并展示 stderr。
* 超时（`backend.timeoutMs`，默认 30 秒）会得到 `PLUGIN_TIMEOUT`，进程被终止。
* 缺少所需权限时得到 `PERMISSION_DENIED`；API 版本不兼容时得到 `PLUGIN_API_UNSUPPORTED`。
  两种错误都会进入插件日志，并在桌面界面出现通知。

### 6.3 钩子清单

插件在 `plugin.json` 的 `hooks` 里声明要接收哪些钩子；未声明的不会被调用（避免无谓地拉起进程）。

| 钩子 | 触发时机 | `params` 主要内容 | 返回值 |
| --- | --- | --- | --- |
| `plugin.install` | 插件包安装完成后 | `plugin`、`source` | `data` |
| `plugin.enable` / `plugin.disable` | 启用 / 停用前后 | `plugin` | `data` |
| `plugin.uninstall` | 卸载前（插件目录仍存在） | `plugin`、`purgeData` | `data` |
| `server.beforeStart` | 每次启动服务器前，需要 `servers.read`；返回 patch 还需要 `server.start.patch` | `server`（完整记录）、`serverDir` | **`patch`**，或用 `cancel` + `reason` 阻止启动 |
| `server.afterStart` | 启动流程结束（成功或失败） | `server`、`ok`、`status`、`message`、`elapsedMs` | `data` |
| `server.beforeStop` / `server.afterStop` | 停止服务器前后 | `server` | `data` |
| `server.beforeBackup` / `server.afterBackup` | 备份前后 | `server`、`backup` | `data` |
| `server.configApplied` | 配置文件被修改后 | `server`、`changes` | `data` |
| `scheduler.tick` | 定时任务心跳 | `timestamp` | `data` |

通配写法：`"server.*"` 匹配所有 `server.` 前缀的钩子。

### 6.4 启动补丁（性能优化类插件的主入口）

`server.beforeStart` 的返回值可以带 `patch`。管理器把所有插件的补丁合并后写入
`<服务器目录>/.mcsm/start-patch.json`，并在真正启动时应用：

| patch 键 | 类型 | 作用 |
| --- | --- | --- |
| `jvmArgs` | `string[]` | 追加 JVM 参数。容器模式合并进 `JAVA_OPTS`；本机 JDK 模式写入生成的启动脚本 |
| `env` | `object` | 追加容器环境变量（仅容器模式） |
| `dockerArgs` | `string[]` | 追加 `docker run` 参数，例如 `["--cpus","4"]`（仅容器模式） |
| `note` | `string` | 说明，写入补丁文件并显示在启动日志中 |
| `cancel` / `reason` | `bool` / `string` | 设为 `true` 可直接阻止本次启动并给出原因 |

行为细节：

* 访问任何 `server.*` 钩子都需要 `servers.read`。
* patch 中的 `jvmArgs` / `env` 需要 `server.start.patch`；`dockerArgs` 还需要 `docker.args`。
  未授权部分会被忽略并记录警告，不会静默生效。
* 补丁在**每次启动前重建**；没有任何插件声明 `server.beforeStart` 时补丁文件会被删除。
* 启动脚本里会打印 `[mcsm] plugin tuning: <插件 id>`，便于确认哪个插件生效。
* 生成的启动脚本从不被手工修改，停用插件即可恢复原样。

### 6.5 自定义方法（RPC）

除了钩子，插件可以实现任意方法名，供命令行或界面调用：

```powershell
mcsm-cli plugin call --name com.example.ops-console --method summary
mcsm-cli plugin call --name com.example.ops-console --method reload --params "{\"force\":true}" --timeout 60000
```

前端脚本里的等价写法：

```js
mcsm.backend.invoke("plugin call --name com.example.ops-console --method summary", cb);
```

建议实现的元方法：

| 方法 | 约定 |
| --- | --- |
| `info` / `describe` | 返回 `{name, version, capabilities[]}`，供运维脚本自检 |
| `health` | 返回 `{ok:true}`，用于监控 |
| `shutdown` | 释放资源（停用插件前管理器会调用 `plugin.disable` 钩子） |

### 6.6 Node.js 最小示例

```js
const readline = require("readline");
const reply = (object) => process.stdout.write(JSON.stringify(object) + "\n");

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "server.beforeStart") {
    return reply({
      ok: true,
      patch: { jvmArgs: ["-XX:+AlwaysPreTouch"], note: "已应用预设参数" }
    });
  }
  reply({ ok: false, error: { code: "METHOD_NOT_FOUND", message: request.method } });
});
```

Python/Java/原生可执行后端不受 API 2 支持。需要独立能力时请拆成受权限约束的 Node.js 后端。

---

## 7. 支持库 / Web 面板类插件

“以 Web 形式实现的运维管理”这类插件把界面放在浏览器里，管理器只负责**启动 / 停止服务**与**打开面板**。

```json
"web": { "entry": "web/index.html", "service": "backend/server.js", "port": 18765, "title": "运维面板" }
```

| 命令 | 行为 |
| --- | --- |
| `plugin service start --name <id>` | 以分离进程启动 `web.service`，返回 pid 与访问 URL |
| `plugin service status --name <id>` | 返回 `running` / `listening` / pid / URL / 静态页面路径 |
| `plugin service stop --name <id>` | 结束进程（含子进程） |

启动服务时注入的环境变量：

| 变量 | 含义 |
| --- | --- |
| `MCSM_PLUGIN_ID` | 插件 id |
| `MCSM_PLUGIN_DIR` | 插件安装目录 |
| `MCSM_PLUGIN_DATA` | 插件数据目录（可写） |
| `MCSM_PLUGIN_PORT` | 声明的端口（若 `web.port` 存在） |
| `MCSM_MANAGER_VERSION` | 当前管理器版本 |

界面上的「打开面板」按钮会先 `service start`，再从返回的 `url` 打开浏览器；
若插件只提供静态 `web.entry` 而没有 `service`，则直接用浏览器打开该 HTML 文件。

启动服务需要 `web.service` 权限。建议服务只监听 `127.0.0.1`；需要对外访问时请做成显式配置项并在
README 里说明，同时必须在安装页说明 `network.outbound` 的实际用途。

---

## 8. 权限、安全与隔离

API 2 把 `permissions` 当作**声明即契约**：清单中声明的能力可以被用户授权，未声明的能力永远不能被
授权。新安装默认授予零项权限；用户必须逐项确认。插件升级后若声明了新的敏感权限，重新导入页会把
它们标为“新增权限”，默认不勾选。

### 8.1 权限目录

| 权限 | 风险 | 控制的能力 |
| --- | --- | --- |
| `ui.pages` | low | 注册页面、按钮、通知，更新该插件自己的页面 |
| `settings.read` | medium | 读取不在该插件私有命名空间内的管理器设置 |
| `servers.read` | medium | 服务器列表、详情、状态、日志、配置、备份列表与 `server.*` 钩子 |
| `servers.control` | high | 启动、停止、重启、强制结束服务器 |
| `console.send` | high | 通过 RCON 向服务器控制台发命令 |
| `server.delete` | critical | 永久删除服务器记录和目录 |
| `config.write` | high | 应用或回滚服务器配置 |
| `backup.manage` | high | 创建、恢复、删除、安排备份 |
| `server.start.patch` | high | 生命周期钩子修改 JVM 参数或容器环境 |
| `filesystem.server.read` | high | 读取 managed servers 目录 |
| `filesystem.server.write` | critical | 写入 managed servers 目录 |
| `process.spawn` | critical | 从后端启动其它进程 |
| `network.outbound` | high | 访问外部网络；当前版本只作声明提示，见下方限制 |
| `docker.args` | critical | 给 Docker 启动命令追加经过管理器检查的参数 |
| `web.service` | high | 启动插件声明的本地 Web 服务 |
| `filesystem.data` | low | 旧名称；插件私有数据目录无需申请，使用时会提示迁移 |

未知权限、重复权限或未声明却被授予的权限都会导致操作失败。权限 ID 不区分大小写，存储时统一为小写、
去重并排序。

### 8.2 权限在何处强制执行

| 层 | 强制执行 |
| --- | --- |
| 安装/升级 | 清单权限必须全部存在；授予集合必须来自清单；API 1 包不可执行 |
| 前端 `mcsm.api` | 页面、设置、服务器读取按权限返回或拒绝；`mcsm.backend.invoke()` 只允许调用自己的后端和已授权命令 |
| 后端进程 | 默认文件访问仅限插件目录与私有数据；服务器目录写入、子进程启动按权限追加 Node 参数 |
| 生命周期钩子 | `server.*` 需要 `servers.read`；启动补丁和 Docker 参数分别检查专属权限 |
| 权限变更 | 插件管理中保存后立即更新注册表；重新加载插件页面时使用新的授权集合 |

权限拒绝统一返回 `PERMISSION_DENIED`，同时写入插件日志并产生桌面通知。例如：

```json
{
  "ok": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "权限不足：servers.control",
    "detail": "所需权限：servers.control；请在插件管理页面授权"
  }
}
```

用户关闭某项权限后，插件不会自动卸载或停用；这是有意设计，便于用户只关闭高风险能力并继续使用
其余功能。插件应处理这种失败并在自己的页面展示可操作的提示，而不是假定权限永远存在。

### 8.3 隔离边界与残余风险

管理器使用 Node Permission Model、独立子进程、超时限制、受限环境变量和前端 QJSEngine 白名单降低
插件越权风险，但**这不是防恶意代码的操作系统级沙箱**：

* Node Permission Model 是纵深防御，不是对恶意代码的绝对保证；
* 当前 Node 版本不能通过该模型限制所有网络访问，`network.outbound` 仍主要依靠用户信任和审计；
* Windows 下未使用 AppContainer/受限令牌，插件进程仍与当前 Windows 用户共享基础身份；
* Web 服务运行在浏览器中，浏览器自身不能继承 QJSEngine 的能力限制。

因此界面会区分“本地 zip / URL 来源”并展示每一项能力，但用户仍只应安装可信来源的插件。需要
强隔离的不可信代码应放到单独的系统账户、虚拟机或容器中运行。API 2 会拒绝 Python、Java 和原生
可执行后端，正是因为它们无法获得与 Node.js 一致的第一方权限检查。

### 8.4 安装位置：只在管理器目录内

* 插件**只能**安装到 `<数据目录>/plugins/<插件 id>/`（Windows 默认
  `%LOCALAPPDATA%\McServerManager\plugins`）。安装前会校验目标目录确实位于该根目录之内，
  越界直接拒绝（`UNSAFE_PLUGIN_PATH`）——恶意插件无法把文件写到系统目录或别处。
* 插件 id 只允许 `A-Za-z0-9._-`，不能包含路径分隔符，所以无法用 `../` 之类的方式跳出插件目录。

### 8.5 压缩包与入口路径校验

| 检查项 | 行为 |
| --- | --- |
| 绝对路径 / 盘符 / UNC（`C:\…`、`\\server\…`、`/etc/…`） | 拒绝解压（提示"压缩包包含不安全路径"） |
| `..` 跳出解压目录（zip-slip） | 拒绝解压 |
| 符号链接指向外部 | 拒绝（解压后逐个校验落盘路径） |
| `7z l` 读取条目失败 / 条目为空 | **拒绝解压**（fail-closed），不会跳过 zip-slip 校验 |
| 解压后逐个校验落盘文件 | 必须仍在插件目录内，否则报错并清理 |
| `frontend` / `backend` / `web` 入口、`web.service` | 必须是包内相对路径，绝对路径或 `..` 直接拒绝 |
| 后端入口、`include()` 的真实路径 | 必须位于该插件目录内（符号链接会被展开检查） |

### 8.6 运行期隔离（一条卡住不会拖死全部）

| 机制 | 说明 |
| --- | --- |
| 前端脚本预算 | 加载 2500ms、单次事件 1000ms；超时会被强制中断 |
| 前端脚本失控 | 连续超预算的插件在**本次会话内停用**（不再接收事件），插件扩展页会给出提示 |
| 后端插件 | 独立 Node 进程 + Permission Model + 超时保护；失败只变成 `warnings`，不影响其它操作 |
| 界面线程 | 后端调用全部异步且带看门狗；插件拿到的服务器列表是缓存快照，不会同步等待后端 |
| 定时备份守护进程 | 启动时带 `--parent-pid`，管理器被强杀后守护进程自动退出，不留孤儿进程 |

---

## 9. 版本兼容

* `apiVersion` 是整数区间校验（见 §4.3）：只增加新接口时抬 `SUPPORTED_MAX_API`；
  破坏性变更时抬 `SUPPORTED_MIN_API`，旧插件被明确拒绝而不是行为异常。
* **1.3.0 是破坏性升级**：支持区间从 `1..1` 变为 `2..2`。API 1 插件不会执行，需迁移权限、
  显式写 `apiVersion: 2`，并确认后端只使用 Node.js。
* 管理器新增能力时只增加字段、不删除旧字段；插件应当忽略不认识的键。
* 本版（1.2.0）新增的交互能力：`table` 的 `selectable`/`key`/`rowIds`/`selected`、
  `buttons` 的 `action` 与 `pick`、`mcsm.ui.onAction()`、`ui.selection` 事件（见 §5.3.1）。
  用到它们的插件请在 `plugin.json` 里把 `minManagerVersion` 设成 `1.2.0` 或更高，
  这样在旧管理器上会给出明确提示而不是「页面空白」。
* 查询当前接口定义（机器可读，适合生成文档或做自动检查）：

```powershell
mcsm-cli plugin api --pretty
```

```json
{
  "apiVersion": 2,
  "supportedMinApi": 2,
  "supportedMaxApi": 2,
  "managerVersion": "1.3.0",
  "apiVersionPolicy": {
    "type": "integer",
    "bumpOn": "每增加一批新接口 +1",
    "rejectWhen": "不在 supportedMinApi..supportedMaxApi 区间内",
    "minManagerVersion": "仅提示用户，不参与硬校验"
  },
  "manager": "McServerManager plugin package API",
  "package": {
    "layout": ["plugin.json", "frontend/index.js", "backend/index.js", "web/index.html", "README.md"],
    "requiredFields": ["id", "name", "version"],
    "apiVersionType": "整数，每增加一批新接口 +1",
    "supportedApiRange": "2-2"
  },
  "security": {
    "installRoot": "C:/Users/<you>/AppData/Local/McServerManager/plugins",
    "installRootPolicy": "插件只能安装在管理器数据目录的 plugins/ 下",
    "archiveRules": ["禁止绝对路径 / 盘符 / UNC", "禁止 .. 跳出解压目录", "禁止符号链接",
                     "解压后逐个校验落盘路径仍在插件目录内"],
    "entryRules": "frontend/backend/web 入口必须是包内相对路径",
    "permissionPolicy": "默认零授权；清单声明是授权上限；拒绝写入插件日志并通知用户"
  },
  "scopes": { "frontend": "只扩展桌面界面", "backend": "只扩展后端", "web": "支持库 / Web 面板",
              "global": "同时包含前端与后端内容", "auto": "按目录结构自动识别" },
  "frontend": {
    "runtime": "QJSEngine (ES2020, 无 DOM)",
    "globalObject": "mcsm",
    "namespaces": ["mcsm.plugin", "mcsm.ui", "mcsm.storage", "mcsm.settings", "mcsm.servers",
                   "mcsm.backend", "mcsm.events", "mcsm.utils"],
    "pageBlocks": ["heading", "text", "keyvalue", "table", "buttons", "log", "html", "divider", "progress"],
    "events": ["app.ready", "theme.changed", "server.selected", "servers.refreshed", "ui.selection"],
    "interactive": {
      "table.selectable": {
        "fields": ["selectable", "key", "rowIds", "selected"],
        "description": "表格行前带勾选框，自带全选/全不选与已选计数",
        "event": "ui.selection",
        "eventPayload": ["pageId", "key", "selected", "count"]
      },
      "buttons.action": {
        "field": "action",
        "binding": "mcsm.ui.onAction(pageId, actionId, handler)",
        "callbackPayload": ["pageId", "action", "path"],
        "description": "点击按钮时调用脚本回调，而不是执行 mcsm-cli 命令"
      },
      "buttons.pick": {
        "field": "pick",
        "modes": ["save", "open", "dir", "auto"],
        "fields": ["mode", "title", "filter", "defaultPath", "defaultName"],
        "description": "由管理器弹原生文件对话框，选中的路径经回调的 path 字段返回；auto = 只勾选 1 行时另存为，否则选目录"
      },
      "note": "事件回调有约 1 秒预算（前端看门狗），不要在脚本里同步等待输入"
    }
  },
  "backend": {
    "protocol": "JSON lines over stdin/stdout",
    "runtimes": ["node", "auto"],
    "hooks": ["plugin.install", "plugin.enable", "plugin.disable", "plugin.uninstall",
              "server.beforeStart", "server.afterStart", "server.beforeStop", "server.afterStop",
              "server.beforeBackup", "server.afterBackup", "server.configApplied", "scheduler.tick"],
    "startPatchKeys": ["jvmArgs", "env", "dockerArgs", "note", "cancel", "reason"]
  },
  "cli": {
    "install": "mcsm-cli plugin package install --zip <file>|--url <url> [--grant <ids>|--grant-all]",
    "permissions": "mcsm-cli plugin package permissions --name <id> --grant <ids>"
  },
  "pluginsDir": "C:/Users/<you>/AppData/Local/McServerManager/plugins"
}
```

---

## 9.1 调试与排错

| 场景 | 做法 |
| --- | --- |
| 只想看识别结果 | `plugin package inspect --zip <file>` |
| 前端脚本报错 | 「设置 -> 插件扩展」状态行会显示 `插件 id：错误`；也可用 `mcsm.log()` 输出 |
| 后端没有响应 | `plugin package info --name <id>` 查看 `launchCommand` 与 `launchError`，再用 `plugin call ... --timeout 5000` 手动测试 |
| 钩子未生效 | 确认 `hooks` 里声明了该名字（支持 `server.*`），且插件处于**已启用**状态 |
| 启动参数没变化 | 查看 `<服务器目录>/.mcsm/start-patch.json`，以及 `start.sh` / `start.cmd` 里的 `[mcsm] plugin tuning` 行 |
| 查看运行日志 | 后端日志 `<数据目录>/logs/backend.log`（含插件错误） |
| 干净重装 | `plugin package remove --name <id> --purge-data` 后重新导入 |

---

## 10. 命令速查

| 命令 | 说明 |
| --- | --- |
| `plugin packages [--enabled]` | 列出插件包（可只列已启用） |
| `plugin package install --zip <file> [--force] [--disabled] [--expect <id>] [--grant <ids>|--grant-all]` | 从本地 zip 安装并授权 |
| `plugin package install --url <url> [--force] [--grant <ids>|--grant-all]` | 从 URL 安装并授权 |
| `plugin package inspect --zip <file>` / `--url <url>` | 只校验并输出识别结果 |
| `plugin package list` / `plugin package info --name <id>` | 列表 / 详情（含启动命令与服务状态） |
| `plugin package enable` / `disable --name <id>` | 启用 / 停用（触发对应钩子） |
| `plugin package permissions --name <id> [--grant <ids>]` | 查看或修改已授权限；空值撤销全部 |
| `plugin package remove --name <id> [--purge-data]` | 卸载（触发 `plugin.uninstall`） |
| `plugin call --name <id> --method <m> [--params '{...}'] [--timeout ms]` | 调用后端方法 |
| `plugin hook --name <id>` / `--all --hook <h> [--payload '{...}']` | 手动触发钩子 |
| `plugin service start` / `stop` / `status --name <id>` | 管理 Web 面板服务 |
| `plugin api` | 输出机器可读接口清单 |

---

## 11. 示例插件

| 目录 | 作用域 | 演示内容 |
| --- | --- | --- |
| `examples/plugins/hello-panel` | 前端 | 注册页面、表格、按钮执行后端命令、事件订阅 |
| `examples/plugins/perf-tuner` | 后端 | `server.beforeStart` 按内存追加 JVM 参数并写入启动补丁 |
| `examples/plugins/ops-console` | 全局 | 前端页面 + JSON-Line 后端 + 本地 Web 面板服务 |

打包命令：

```powershell
powershell -File examples\plugins\build-examples.ps1   # 输出到 dist\plugins\
```
