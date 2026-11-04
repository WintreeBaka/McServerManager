# 社区插件索引（预留）

这里用于登记社区维护的管理器插件：**只放清单与链接**，不提交第三方二进制文件。

当前状态：**预留，暂无条目**。

## 提交条目

提交 PR 时请补充一行：

| 插件 | 作用域 | 作者 | 源码 / 发布页 | 说明 |
| --- | --- | --- | --- | --- |
| （示例） | frontend | @someone | https://github.com/... | 一句话说明 |

要求：

1. 插件包通过 `mcsm-cli plugin package inspect` 校验；
2. `plugin.json` 里声明 `license`，并在项目 README 中说明权限用途；
3. 不提交可执行二进制；发布包请放在作者自己的 Releases 里。

> 管理器插件是受信任扩展，安装前请自行确认来源（见
> [docs/PLUGIN-SDK.md](../../docs/PLUGIN-SDK.md) 第 8 节）。
