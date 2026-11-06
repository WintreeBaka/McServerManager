# McServerManager 1.1.2

1.1.2 带来**首个官方插件「玩家管理」**，并修正插件页面按钮在深色主题下看起来像禁用的问题。

## 下载

| 文件 | 说明 |
| --- | --- |
| `McServerManager-1.1.2-win64.zip` | Windows 10/11 64 位便携版，解压即用（不需要安装 Qt 或 Java） |
| `PLUGIN-SDK.md` | 插件接口说明文档（单独附件，也随包放在 `docs/`） |
| `com.mcsm.player-admin-1.0.0.zip` | 官方插件「玩家管理」安装包（也可从源码 `plugins/official/player-admin` 自行打包） |

> 使用前请先安装并启动 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。
> 玩家管理插件需要 **Node.js**（在 PATH 中），以及服务器的 `enable-rcon=true`（管理器创建的服务器默认开启）。

## 官方插件：玩家管理（player-admin）

安装后左侧菜单会出现 **⚔ 玩家管理**，针对当前选中的服务器：

| 分类 | 能力 |
| --- | --- |
| 白名单 | 查看 / 加入 / 移出 / 开启 / 关闭 / 重载；离线时可写 `whitelist.json` |
| 封禁 | 查看 / 封禁 / 解封；离线时可写 `banned-players.json` |
| OP | 查看 / 设为 OP / 取消 OP；离线时可写 `ops.json` |
| 玩家操作 | 踢出、封禁、标题（含副标题）、私信、游戏模式、击杀、全服广播 |
| 玩家来源 | 在线玩家（RCON `list`）+ 已知玩家（`usercache.json`） |

* 版式：名单用表格；在线/已知玩家按「一名玩家一行」排列，紧接着是该玩家自己的按钮。
* 在线时通过 RCON 执行（由服务端写名单，正版 UUID 正确）；服务器未运行时退化为直接写名单文件，
  并在页面上提示 UUID 与重启要求。
* 文案（标题、踢出/封禁理由、私信）放在 `<数据目录>/plugins/.data/com.mcsm.player-admin/texts.json`，
  首次打开自动生成，修改后约 20 秒生效。
* 安全：玩家名只允许 `A-Za-z0-9_`（1–16 位），文案会去掉换行并限制长度，防止 RCON 指令拼接。

## 界面

* 插件页面按钮支持 `buttons.items[].level`：`primary`（默认）/ `outline`（可写 `ghost`）/
  `soft` / `danger`。此前固定为半透明 Soft，深色主题下与禁用状态难以区分。

## 其他

* 插件在没有管理器传入路径时，Windows 默认数据根目录改为 `%LOCALAPPDATA%\McServerManager`
  （与 `mcsm-cli` 保持一致）。
* 冒烟测试增加到 **68 项**，新增「官方插件包必须有效」校验。

## 升级说明

* 直接从 1.1.1 覆盖即可，数据目录与服务器不受影响。
* 想在 1.1.2 中使用玩家管理：下载上面的插件 zip，或从源码执行
  `powershell -File plugins\build-plugins.ps1` 后导入。
* 插件接口仍是 `apiVersion: 1`，`SUPPORTED_MIN_API` / `SUPPORTED_MAX_API` 均为 1，已有插件无需改动。
