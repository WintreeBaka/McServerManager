# 插件目录

这个目录用于存放**管理器插件（Plugin SDK）**的源码：前端扩展、后端服务、Web 运维面板，
以及同时包含前后端的全局插件。

| 目录 | 用途 |
| --- | --- |
| [`official/`](official/) | 随本项目维护的官方插件：`container-porter`（容器搬运工 · 完整版）、`container-porter-cli`（容器搬运工 · 只有后端的 CLI 版）、`player-admin`（玩家管理） |
| [`community/`](community/) | 社区插件索引：只放清单与链接，不提交第三方二进制（预留） |
| [`../examples/plugins/`](../examples/plugins/) | 可直接安装的示例插件（hello-panel / perf-tuner / ops-console） |

> **1.3.0 破坏性升级：**当前 `official/` 和 `examples/` 中的插件清单仍为 API 1，管理器会保留
> 安装记录和源码用于迁移，但不会执行它们。API 2 需要逐项声明权限、在安装时由用户授权，并把
> 后端改为 Node.js。迁移完成前不要把旧清单当作可运行示例。

> 注意区分三个"plugins"：
>
> * 本目录 `plugins/`：**插件的源码**（随仓库提交）。
> * `dist/plugins/*.zip`：**打包产物**（`.gitignore` 忽略，不上传仓库）。
> * `<数据目录>/plugins/`：管理器**运行时安装位置**（Windows 默认 `%LOCALAPPDATA%\McServerManager\plugins`）。

## 新增一个官方插件

```
plugins/official/<插件名>/
├─ plugin.json           必需，apiVersion 为整数（1.3.0 起必须为 2）
├─ README.md             说明用途、权限与配置
├─ frontend/index.js     可选：界面扩展
├─ backend/index.js      可选：后端钩子 / RPC
└─ web/index.html        可选：Web 面板
```

约定：

1. `plugin.json` 的 `id` 建议使用 `com.wintreebaka.<name>` 形式，只允许 `A-Za-z0-9._-`；
2. `apiVersion` 写**整数** `2`；`permissions` 只能使用 SDK 权限目录中的 ID，未声明能力不能授权；
3. 插件包只能安装到管理器数据目录内，入口必须是包内相对路径（详见
   [docs/PLUGIN-SDK.md](../docs/PLUGIN-SDK.md) 第 8 节）；
4. 每个插件自带 `README.md` 与 `license` 字段；第三方代码请注明来源与许可。

## 打包与自测

```powershell
# 打包 plugins/official 下的全部插件（使用随项目内置的 7-Zip）
powershell -File plugins\build-plugins.ps1

# 只校验、不安装（会输出自动识别的作用域）
build\bin\mcsm-cli.exe plugin package inspect --zip dist\plugins\<id>-<version>.zip

# 安装到本机管理器；默认零权限，只授予本次开发实际需要的能力
build\bin\mcsm-cli.exe plugin package install --zip dist\plugins\<id>-<version>.zip --force --grant ui.pages,servers.read
```

接口与钩子参考：[docs/PLUGIN-SDK.md](../docs/PLUGIN-SDK.md)；
可用 `build\bin\mcsm-cli.exe plugin api` 导出机器可读的接口清单。
