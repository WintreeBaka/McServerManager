# 容器搬运工 1.0.0

**容器搬运工**是随 McServerManager 维护的官方插件：把一台 Minecraft 服务器连同它的 Docker 容器导出成一个
`.tar` 容器包，换一台机器再导入回来 —— 不用重新下载服务端、重装插件、重配端口。

1.0.0 是第一个正式版，**提供两个包，按环境选一个安装**：

| 包 | 插件 id | 作用域 | 适用场景 |
| --- | --- | --- | --- |
| `com.mcsm.container-porter-1.0.0.zip` | `com.mcsm.container-porter` | `global`（前端 + 后端） | 桌面管理器：左侧导航多出「导入与导出」页面，鼠标勾选、点按钮 |
| `com.mcsm.container-porter.cli-1.0.0.zip` | `com.mcsm.container-porter.cli` | `backend`（只有后端） | 只装了 `mcsm-cli` 的机器、服务器主机、脚本 / CI |

两个包的**后端是同一份代码**，导出的容器包格式一致，可以互相导入（完整版导出的包 → CLI 版导入 ✔，反之亦然）。
完整版需要管理器 1.2.0 及以上（用到了 1.2.0 引入的插件页交互接口）。

## 能做什么

* **勾选服务器导出**：每行前面有勾选框，表格右上角有「全选 / 全不选」；「当前选中服务器」显示已选项与数量
  （超过三台显示成「A、B、C 等 N 台」）。
* **导出前先选位置**：勾选一台弹出「另存为」（可改文件名），勾选多台弹出「选择文件夹」，每台各生成一个包。
* **三种导出粒度**：数据 + 配置 / 含容器镜像（`docker commit` + `docker save`）/ 完整导出（再加备份与日志）。
* **选择容器包导入…**：挑一个 `.tar` 包，自动分配新的 id 与端口、必要时改写 `server.properties`，
  并把服务器**直接加入服务器列表**（约 5 秒内界面刷新）。
* CLI 版没有界面，全部通过 `mcsm-cli plugin call --method export~…/import~…/scan` 完成，用法见包内 README。

## 安装

```powershell
# 桌面管理器：设置 → 插件扩展 → 添加插件，选择 zip；或：
mcsm-cli plugin package install --zip "com.mcsm.container-porter-1.0.0.zip"

# 只装了命令行的机器：
mcsm-cli plugin package install --zip "com.mcsm.container-porter.cli-1.0.0.zip"
```

本发行版同时提供 **`McServerManager-1.2.0-win64-with-container-porter.zip`**：管理器本体 + 两个插件包
（解压后位于 `plugin-packages\`，附 `安装说明.txt`），解压即用。

## 容器包里有什么

```
manifest.json    导出时间、插件版本、镜像引用、服务器记录快照
data.tar         服务器目录（world / plugins / 配置 / start.sh …）
image.tar        可选，docker save 出来的镜像（只有「含镜像 / 完整导出」才有）
```

## 已知限制

* 需要 `docker` 在 PATH 里；导出/导入数据不需要守护进程，只有「含镜像」与启动服务器时才需要。
* `/data` 是 bind mount，所以世界数据来自 `data.tar`，`docker commit` 只负责容器内部的文件变动。
* 导入会直接读写 `<数据目录>/servers.json`，建议导入时不要在管理器里同时启停服务器。

## 兼容性

* 管理器：1.2.0 及以上；插件数据格式与 0.1.0 / 0.2.x 一致，旧容器包可以直接导入。
* 0.2.2 之前导出的容器包，`manifest.json` 里的 `plugin.version` 记为 `1.0.0`（当时后端版本号写死），
  导入不校验该字段，不影响使用。
