# McServerManager 1.2.1

1.2.1 修复仪表盘运行环境状态不刷新的问题，并同步提升管理器版本号。

## 下载

| 文件 | 说明 |
| --- | --- |
| `McServerManager-1.2.1-win64.zip` | Windows 10/11 64 位**含 GUI 的便携版**（不需要安装 Qt 或 Java） |
| `McServerManager-1.2.1-win64-cli.zip` | **纯 CLI 精简版**，适合脚本、服务器或无桌面环境 |
| `PLUGIN-SDK.md` | 插件接口文档（单独附件，也随包放在 `docs/`） |

> 使用前请安装并启动 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。

## 修复

* 仪表盘「运行环境」现在会在环境诊断完成后更新 Docker、JDK 镜像和数据目录状态，
  不再一直停留在「检测中」。
* 环境结果监听改为页面创建时连接一次，后续间歇诊断和手动刷新都会直接更新仪表盘。

## 升级说明

* 直接覆盖解压到原目录即可，数据目录、服务器记录、配置备份和管理器插件不受影响。
* 插件接口（apiVersion 1）没有变化，已安装的管理器插件可以继续使用。
