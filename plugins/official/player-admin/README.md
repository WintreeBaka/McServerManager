# 玩家管理（McServerManager 官方插件）

给 McServerManager 增加一块「玩家管理」页面：对**当前选中的服务器**管理白名单、
黑名单（封禁）与 OP 管理员名单，并执行踢出、封禁、标题、私信、游戏模式等玩家操作。

> 需要 McServerManager **1.1.1 或更高**（插件接口 `apiVersion: 1`）。
> 源码位置：`plugins/official/player-admin/`。

## 功能

| 分类 | 能力 |
| --- | --- |
| 白名单 | 查看 / 加入 / 移出 / 开启 / 关闭 / 重载；离线时可写 `whitelist.json` |
| 黑名单 | 查看 / 封禁 / 解封；离线时可写 `banned-players.json` |
| OP 名单 | 查看 / 设为 OP / 取消 OP；离线时可写 `ops.json` |
| 玩家操作 | 踢出、封禁、标题（含副标题）、私信、游戏模式 |
| 玩家来源 | 在线玩家（RCON `list`）+ 已知玩家（`usercache.json`） |

## 版式

* 名单用**真正的表格**展示，列对齐：玩家 / 状态 / 标记列，方便快速扫读。
* 在线玩家与已知玩家按**一名玩家一行**排列：先一行玩家名（含"白名单 · 管理员"等标记），
  紧接着一行是他自己的操作按钮。玩家多的时候不会出现"横向找玩家"的问题。
* 按钮色调：主要操作用主按钮样式，`取消 OP` / `移出白名单` / 模式切换用描边次按钮，
  `封禁` / `击杀` 用红色危险样式。

## 自定义文案

原生插件页面没有文本输入框，所以标题内容、踢出/封禁理由、私信内容放在插件数据目录：

```
<数据目录>/plugins/.data/com.mcsm.player-admin/texts.json
```

首次打开页面时会自动生成，内容形如：

```json
{
  "title": "欢迎回来",
  "subtitle": "",
  "kickReason": "违反服务器规则",
  "banReason": "违反服务器规则",
  "tell": "请注意服务器规则"
}
```

用记事本改完保存即可，页面里「按钮文案」一节会显示当前生效的值（约 20 秒自动刷新）。
需要一次性发别的文本时，也可以在管理器的「控制台」页直接发 `/title`、`/kick` 等原版指令。

## 安装

```powershell
# 打包（在仓库根目录执行；产物在 dist\plugins\）
powershell -File plugins\build-plugins.ps1

# 预览识别结果，然后安装
build\bin\mcsm-cli.exe plugin package inspect --zip dist\plugins\com.mcsm.player-admin-1.0.0.zip
build\bin\mcsm-cli.exe plugin package install --zip dist\plugins\com.mcsm.player-admin-1.0.0.zip
```

图形界面等价入口：**设置 → 插件扩展 → 添加插件**。
插件只会安装到 `<数据目录>\plugins\` 下（管理器会校验安装路径与压缩包条目，
防止 zip-slip 与越界写入）。

## 实现要点

* **按钮命令的传参**：按钮只能执行一条命令，而命令会被按空格/引号切分。因此参数用百分号
  编码后写进 `--method`：

  ```
  plugin call --name com.mcsm.player-admin --method run|kick|survival|Steve|%E7%90%86%E7%94%B1
  ```

  方法名里没有空格与引号，任何一种分词方式都不会把它拆坏；后端再 `decodeURIComponent` 还原。
* **数据来源**：优先 RCON（由服务器自己写名单文件，正版 UUID 正确）；服务器未运行时退化为
  直接编辑名单文件，并把注意事项写进 warnings（例如正版模式下无法确认 UUID）。
* **不依赖 mcsm-cli**：后端自带纯 Node 的 RCON 客户端，直接读 `servers.json` 里的端口与密码。
* **刷新**：插件收不到定时事件，但管理器约每 20 秒会派发 `environment.changed`，
  页面借此重新拉取快照，只有内容真的变了才重绘（重绘会清空输出框）。
* **按钮色调**：插件页面的按钮样式由管理器的 `PluginPageView` 决定，`buttons.items[].level`
  取值 `primary`（默认）/ `outline` / `soft` / `danger`。管理器 1.1.1 之前只会区分 `danger`，
  其余一律画成半透明的 Soft（深色主题下看起来像禁用），该问题已在管理器侧修正。
* **参数安全**：玩家名只允许 `A-Za-z0-9_`（1–16 位），理由 / 标题 / 私信会去掉换行并限制长度，
  避免通过 RCON 拼接执行第二条指令。

## 依赖与限制

* 后端需要 **Node.js**（在 PATH 里即可）。
* 踢出 / 标题 / 私信 / 游戏模式 / 在线列表需要服务器**正在运行**且 `enable-rcon=true`
  （管理器创建的服务器默认开启）。
* 离线管理名单时，正版模式（`online-mode=true`）会尝试调用 Mojang 档案接口解析 UUID；
  网络不可用时会退回离线 UUID 并给出提示，请在服务器运行时重做一次。
* 单个按钮行不会换行，名单类操作按名字最多列出 12 条，其余请用表格对照后在「控制台」处理。

## 目录

```
plugins/official/player-admin/
├── plugin.json              清单（scope=global：前端 + 后端）
├── frontend/index.js        管理器内的原生页面（表格 + 按玩家分行）
├── backend/index.js         后端方法（JSON-Line 协议）
└── backend/lib/mcsm.js      共享核心：路径 / RCON / 名单读写 / 文案 / 玩家操作
```
