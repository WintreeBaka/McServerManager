# 容器搬运工（Container Porter）

把选中的 Minecraft 服务器连同它的 Docker 容器导出成一个 `.tar` 容器包，换一台机器再导入回来，
省去重新下载服务端、重装插件、重配端口的过程。

这是 **管理器插件包**（Plugin SDK，apiVersion 1），不是 Minecraft 服务端插件。

## 功能

安装并启用后，左侧导航会多出一个 **「导入与导出」** 页面：

* **服务器表格可以勾选** —— 每行前面有勾选框，表格右上角有「全选 / 全不选」，
  「当前选中服务器」一行会显示已勾选的服务器（超过三台显示成「A、B、C 等 N 台」）与数量。
* **导出选中（数据 + 配置）** —— 打包 `world/`、`plugins/`、`mods/`、`server.properties`、
  `start.sh`、`config-backups/` 等，得到一个几十 MB 级别的容器包（不含备份和日志）。
* **导出选中（含容器镜像）** —— 额外执行 `docker commit` + `docker save`，把容器的整个镜像也装进包里。
  包会大很多（等于镜像体积），但目标机器就算没有同名镜像也能直接跑。
* **完整导出（含备份）** —— 再加上 `backups/` 与 `logs/`。
* **选择容器包导入…** —— 先弹出文件选择框挑一个 `.tar` 包，再解开、把数据放到新的服务器目录，
  自动分配新的 id / 端口，并把服务器**直接加入服务器列表**（约 5 秒内界面就会刷新出来）。

导出时**先选保存位置再导出**：勾选一台会弹出「另存为」（可以直接改文件名）；
勾选多台会弹出「选择文件夹」，每台各生成一个包。取消对话框不会导出任何东西。

页面里还有「重新扫描导出目录」与「打开导出目录」两个辅助按钮。

## 容器包里有什么

单个 `.tar`，内部结构：

```
manifest.json    导出时间、插件版本、镜像引用、服务器记录快照
data.tar         服务器目录（world / plugins / 配置 / start.sh …）
image.tar        可选，docker save 出来的镜像（只有「含容器镜像 / 完整导出」才有）
```

导出目录默认在 **`<数据目录>/exports/`**（Windows 默认
`%LOCALAPPDATA%\McServerManager\exports`，页面里会显示完整路径），
用「打开导出目录」可以直接跳过去；也可以用对话框选到别的位置。

导入时：

* 若包里有 `image.tar`，先 `docker load` 载入镜像，记录的 `image` 指向它；
* 否则沿用记录里的镜像名，服务器第一次启动时管理器会自动 `docker pull`；
* 端口若与现有服务器冲突，会换成空闲端口，并同步改写 `server.properties`
  里的 `server-port` / `rcon.port`；
* 名称重复时自动加「（导入）」后缀。

## 手动调用（命令行）

图形界面里的按钮等价于：

```powershell
# 导出（0=数据+配置，1=含镜像，2=含备份；多台用逗号分隔，最后一个参数是目标文件或目录）
mcsm-cli plugin call --name com.mcsm.container-porter --method "export~survival~1"
mcsm-cli plugin call --name com.mcsm.container-porter --method "export~survival,test~0~D%3A%5Cbackup"

# 列出导出目录里的容器包
mcsm-cli plugin call --name com.mcsm.container-porter --method scan

# 导入（路径需要 encodeURIComponent 编码）
mcsm-cli plugin call --name com.mcsm.container-porter --method "import~D%3A%5Cdata%5Csurvival-20261116-200000.tar"
```

参数编码进方法名，是为了绕开 `plugin call` 命令行里 JSON 引号被解析掉的问题。
省略目标路径时，包会落在默认导出目录。

## 限制与注意

* 需要 `docker` 在 PATH 里；导出/导入数据不需要守护进程，只有「含镜像」与启动时才需要。
* 导出运行中的容器时，`docker commit` 会捕获容器内部的文件变动，但 `/data` 是 bind mount，
  世界数据来自服务器目录（`data.tar`），两者会一起打包。
* 不含 `backups/` 与 `logs/`，除非用「完整导出」。
* 导入会直接读写 `<数据目录>/servers.json`；如果此时正好有别的操作在写注册表，
  极小概率会被覆盖，建议导入时不要在管理器里同时启停服务器。
* 端口只检查管理器已知的服务器，不检查宿主机其它程序占用的端口。
