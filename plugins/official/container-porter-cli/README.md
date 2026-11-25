# 容器搬运工（CLI 版）

和 [完整版](../container-porter/) 功能相同：把 Minecraft 服务器连同它的 Docker 容器导出成一个 `.tar`
容器包，换一台机器再导入回来。区别只有一点 —— **这个版本没有界面**。

- **完整版** `com.mcsm.container-porter`：作用域 `global`（前端 + 后端），装进桌面管理器后，
  左侧导航会多出「导入与导出」页面，用鼠标勾选、点按钮即可。
- **CLI 版**（本目录）`com.mcsm.container-porter.cli`：作用域 `backend`（只有后端），
  没有页面、没有 `frontend/` 目录，适合只安装了 `mcsm-cli` 的机器（服务器主机、脚本、CI）。

两个包的**后端代码完全相同**（同一份 `backend/index.js`，只差 `plugin.json` 里的 id 与作用域），
所以导出的容器包格式一致，可以互相导入：

* 完整版导出的包 → CLI 版导入 ✔
* CLI 版导出的包 → 完整版导入 ✔

## 安装

```powershell
# 只装了命令行版的机器（发行包 McServerManager-<版本>-win64-cli.zip 里只有 mcsm-cli.exe）
mcsm-cli plugin package install --zip dist\plugins\com.mcsm.container-porter.cli-1.1.0.zip
mcsm-cli plugin package info --name com.mcsm.container-porter.cli
```

## 用法

没有按钮，全部通过 `plugin call` 调用；参数编码进方法名，避免命令行里的 JSON 引号被解析掉：

```powershell
# 自检：dataRoot、导出目录、可用方法
mcsm-cli plugin call --name com.mcsm.container-porter.cli --method info

# 导出。0=数据+配置，1=含容器镜像，2=含备份与日志
# 单台可以指定 .tar 文件；多台用逗号分隔并给目录；省略目标则落到默认导出目录
mcsm-cli plugin call --name com.mcsm.container-porter.cli --method "export~survival~1"
mcsm-cli plugin call --name com.mcsm.container-porter.cli --method "export~survival,test~0~D%3A%5Cbackup"

# 列出导出目录里的容器包（返回 name / sizeBytes / hasImage / mtime / serverName）
mcsm-cli plugin call --name com.mcsm.container-porter.cli --method scan

# 导入（路径要 encodeURIComponent 编码）
mcsm-cli plugin call --name com.mcsm.container-porter.cli --method "import~D%3A%5Cbackup%5Csurvival-20261117-200000.tar"

# 非本机包载入镜像 / 使用 host 运行时时必须显式确认
mcsm-cli plugin call --name com.mcsm.container-porter.cli --method "import~D%3A%5Cbackup%5Csurvival-20261117-200000.tar~allowHost=1&allowUntrustedImage=1"

# 打开导出目录（在 Windows 资源管理器里）
mcsm-cli plugin call --name com.mcsm.container-porter.cli --method open-folder
```

容器包默认不包含原 RCON 密码，导入时会生成新密码。容器包仍可能包含世界、日志和插件，
属于敏感资产。路径中的 `~` 需要编码为 `%7E`。

导入会直接写 `<数据目录>/servers.json`，所以下一次 `mcsm-cli server list` 就能看到新服务器；
如果桌面管理器正好开着，它会在约 5 秒内自动刷新出来。

## 容器包里有什么

```
manifest.json    导出时间、插件版本、镜像引用、服务器记录快照
data.tar         服务器目录（world / plugins / 配置 / start.sh …）
image.tar        可选，docker save 出来的镜像（只有 1 / 2 模式才有）
```

导入时：有 `image.tar` 就先 `docker load`；端口冲突会自动换空闲端口并改写 `server.properties`
的 `server-port` / `rcon.port`；名称重复加「（导入）」后缀。

## 限制与注意

* 需要 `docker` 在 PATH 里（只有 1 模式导出与启动服务器时才真正需要守护进程）。
* 不含 `backups/` 与 `logs/`，除非用模式 2。
* 端口只检查管理器已知的服务器，不检查宿主机其它程序占用的端口。
* 命令行版没有界面，装完整版会多出一个永远用不到的前端页面 —— 两种包 id 不同、可以共存，
  但同一台机器按需只装一个就够了。
