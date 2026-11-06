# 官方插件（预留）

这里用于存放随 McServerManager 一起维护的插件源码。

当前状态：已有 1 个官方插件。

| 插件 | 作用域 | 说明 |
| --- | --- | --- |
| [`player-admin/`](player-admin/) | global（前端 + 后端） | 玩家管理：白名单 / 封禁 / OP 名单，以及踢出、标题、私信、游戏模式等在线/离线操作 |

想先看能做什么，可以参考示例：

| 示例 | 作用域 | 演示内容 |
| --- | --- | --- |
| [`examples/plugins/hello-panel`](../../examples/plugins/hello-panel) | 前端 | 注册页面、表格、按钮执行后端命令、事件订阅 |
| [`examples/plugins/perf-tuner`](../../examples/plugins/perf-tuner) | 后端 | `server.beforeStart` 按内存追加 JVM 参数 |
| [`examples/plugins/ops-console`](../../examples/plugins/ops-console) | 全局 | 前端页面 + JSON-Line 后端 + 本地 Web 面板 |

新增插件时，在本目录下创建 `<插件名>/plugin.json`，并参照
[`plugins/README.md`](../README.md) 的约定。
