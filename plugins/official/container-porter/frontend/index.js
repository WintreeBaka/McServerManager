/*
 * 容器搬运工 —— 前端部分：在左侧导航注册「导入与导出」页面。
 *
 * 页面里的按钮只能执行一条命令行（由管理器转给 mcsm-cli），所以参数直接编码进方法名：
 *   export~<服务器id>~<模式>        模式 0=数据+配置，1=再带镜像，2=再带备份与日志
 *   import~<encodeURIComponent(path)>   导入容器包
 *   scan / open-folder
 */
(function () {
    var pluginId = mcsm.plugin.id;
    var pageId = mcsm.ui.registerPage({
        id: "import-export",
        title: "导入与导出",
        icon: "⇄",
        subtitle: "把选中的服务器导出成容器包，或把容器包导入成新服务器"
    });

    var bundles = [];
    var exportDir = "";
    var lastCount = -1;
    var lastScanAt = 0;

    function command(method) {
        return "plugin call --name " + pluginId + " --method " + method;
    }

    function humanSize(bytes) {
        try {
            return mcsm.utils.humanBytes(Number(bytes) || 0);
        } catch (error) {
            return String(bytes) + " B";
        }
    }

    function localTime(iso) {
        var at = new Date(iso);
        if (isNaN(at.getTime())) return String(iso || "");
        function pad(value) { return (value < 10 ? "0" : "") + value; }
        return at.getFullYear() + "-" + pad(at.getMonth() + 1) + "-" + pad(at.getDate())
            + " " + pad(at.getHours()) + ":" + pad(at.getMinutes());
    }

    function clip(text, max) {
        text = String(text || "");
        return text.length > max ? text.slice(0, max - 1) + "…" : text;
    }

    function selectedServer(servers) {
        var id = mcsm.servers.selected();
        for (var i = 0; i < servers.length; i++) {
            if (servers[i].id === id) return servers[i];
        }
        return null;
    }

    function render() {
        var servers = mcsm.servers.list() || [];
        var selected = selectedServer(servers);
        var blocks = [
            { type: "heading", text: "容器搬运工" },
            {
                type: "text",
                style: "hint",
                text: "把一台服务器连同它的容器一起导出成单个 .tar 包，换台机器再导入即可继续用。"
                    + "导出的包保存在导出目录里；导入时会自动分配新的 id 与端口，并直接加入服务器列表。"
            },
            {
                type: "keyvalue",
                items: [
                    ["当前选中服务器", selected ? (selected.name + " · " + selected.type + " · " + selected.status) : "（未选择，先到「服务器」页选一台）"],
                    ["容器名", selected ? "mcsm-" + selected.id : "—"],
                    ["导出目录", exportDir || "（正在读取…）"]
                ]
            }
        ];

        if (servers.length > 0) {
            var rows = [];
            for (var i = 0; i < servers.length; i++) {
                rows.push([servers[i].name, servers[i].type, servers[i].status]);
            }
            blocks.push({ type: "table", title: "服务器", columns: ["名称", "类型", "状态"], rows: rows });
        }

        if (selected) {
            blocks.push({
                type: "buttons",
                items: [
                    { label: "导出选中（数据 + 配置）", command: command("export~" + selected.id + "~0"), toast: "容器包已导出" },
                    { label: "导出选中（含容器镜像）", command: command("export~" + selected.id + "~1"), level: "outline", toast: "容器包已导出" },
                    { label: "完整导出（含备份）", command: command("export~" + selected.id + "~2"), level: "outline", toast: "容器包已导出" }
                ]
            });
        } else {
            blocks.push({ type: "text", style: "caption", text: "先在左侧「服务器」页选中一台服务器，再回到这里导出。" });
        }

        blocks.push({ type: "divider" });
        blocks.push({ type: "heading", text: "导入容器包" });

        if (bundles.length === 0) {
            blocks.push({
                type: "text",
                style: "hint",
                text: "导出目录里还没有 .tar 容器包。先导出一台服务器，或者把别处导出的容器包放进这个目录，再点「重新扫描」。"
            });
        } else {
            var bundleRows = [];
            var imports = [];
            var limit = Math.min(bundles.length, 8);
            for (var j = 0; j < bundles.length; j++) {
                var bundle = bundles[j];
                bundleRows.push([
                    clip(bundle.serverName || bundle.name, 28),
                    humanSize(bundle.sizeBytes),
                    bundle.hasImage ? "含镜像" : "仅数据",
                    localTime(bundle.mtime)
                ]);
            }
            for (var k = 0; k < limit; k++) {
                var item = bundles[k];
                imports.push({
                    label: "导入「" + clip(item.serverName || item.name, 16) + "」",
                    command: command("import~" + encodeURIComponent(item.file)),
                    level: k === 0 ? "primary" : "outline",
                    toast: "已导入到服务器列表"
                });
            }
            blocks.push({
                type: "table",
                title: "可导入的容器包",
                columns: ["服务器", "大小", "内容", "导出时间"],
                rows: bundleRows
            });
            blocks.push({ type: "buttons", items: imports });
            if (bundles.length > limit) {
                blocks.push({ type: "text", style: "caption", text: "只列出最近的 " + limit + " 个包；更早的包可以用「打开导出目录」手动处理。" });
            }
        }

        blocks.push({
            type: "buttons",
            items: [
                { label: "重新扫描", command: command("scan"), level: "outline" },
                { label: "打开导出目录", command: command("open-folder"), level: "outline" }
            ]
        });
        blocks.push({
            type: "log",
            title: "执行结果",
            text: "操作结果会显示在这里。导入完成后，服务器列表会在几秒内自动刷新。"
        });

        mcsm.ui.setPageContent(pageId, blocks);
    }

    /// `plugin call` 的输出是 {ok, data:{ok, data, log, error}}：外层是 CLI 的封装，
    /// 插件自己的结果在 reply.data 里。
    function unwrap(reply) {
        var inner = (reply && reply.data) || {};
        if (inner.ok) return { ok: true, data: inner.data || {} };
        var error = inner.error || {};
        return { ok: false, message: error.message || (reply && reply.error) || "未知错误" };
    }

    function scan() {
        lastScanAt = Date.now();
        mcsm.backend.invoke(["plugin", "call", "--name", pluginId, "--method", "scan"], function (reply) {
            var result = unwrap(reply);
            if (result.ok) {
                bundles = result.data.items || [];
                exportDir = result.data.dir || "";
            } else {
                bundles = [];
                mcsm.log("扫描容器包失败：" + result.message);
            }
            render();
        });
    }

    mcsm.events.on("server.selected", function () {
        render();
    });
    mcsm.events.on("servers.refreshed", function (payload) {
        var count = payload && typeof payload.count === "number" ? payload.count : -1;
        if (count !== lastCount) {
            lastCount = count;
            render();
        }
    });
    mcsm.events.on("app.ready", function () {
        scan();
    });

    render();
    scan();
})();
