# McServerManager 1.3.0

1.3.0 引入管理器插件 API 2 和用户可控的权限模型。这是一次**破坏性升级**。

## 必须知道的兼容变化

* 管理器只接受 `plugin.json` 中显式声明的 `apiVersion: 2`。
* API 1 插件不会被加载或执行。它们仍会出现在插件管理中，标记为“API 不兼容”，便于卸载或
  升级，但对应功能不可用。
* API 2 后端只支持 Node.js。Python、Java 和原生可执行后端因缺少统一权限边界而被拒绝。
* 新安装默认没有任何权限。用户必须在安装页逐项授权，之后可在「插件管理 → 权限」修改。
* 权限被关闭后插件不会自动停用，依赖该能力的操作会失败。失败会写入通知和插件/后端日志。

## 权限模型

插件必须在 `permissions` 中声明能力，未声明能力不能被授权。权限包括：

`ui.pages`、`settings.read`、`servers.read`、`servers.control`、`console.send`、
`server.delete`、`config.write`、`backup.manage`、`server.start.patch`、
`filesystem.server.read`、`filesystem.server.write`、`process.spawn`、
`network.outbound`、`docker.args`、`web.service`。

`filesystem.data` 仅作为旧名称兼容；插件自己的数据目录始终可读写。

前端页面、设置读取、服务器查询和 `mcsm.backend.invoke()` 均经过权限检查。插件只能调用自己的
后端；其他插件控制和管理器管理命令会被拒绝。

## 后端边界

Node.js 24 后端默认只能读插件安装目录、读写自己的数据目录。只有授予
`filesystem.server.read` / `filesystem.server.write` 后才开放 managed servers 目录；
只有授予 `process.spawn` 后才开放子进程。API 2 不再向插件注入 `MCSM_BACKEND` 或
`MCSM_HOME`。

该边界用于降低误操作和越权风险，但不是防恶意代码的完整操作系统沙箱。Node Permission Model
不是对恶意代码的绝对保证，当前 Node 版本也不能限制全部网络访问；Web 面板还运行在浏览器中。
用户仍应只安装可信来源的插件。

## 插件迁移

1. 将 `apiVersion` 改为整数 `2`，把 `minManagerVersion` 设为 `1.3.0`。
2. 从 SDK 权限目录中声明实际需要的能力，删除未知或把钩子名误写成权限的条目。
3. 后端改为 Node.js，处理 `PERMISSION_DENIED`，不再依赖 `MCSM_BACKEND` / `MCSM_HOME`。
4. 在零权限、逐项授权、撤销权限和升级新增权限四种场景下测试失败提示。

当前官方 API 1 插件需要后续迁移，本版本会阻止其执行。

完整说明见 `docs/PLUGIN-SDK.md` 与 `docs/DEVELOPMENT.zh-CN.md` / `docs/DEVELOPMENT.en.md`。
