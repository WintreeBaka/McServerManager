/*
 * 容器搬运工 —— 前端部分：在左侧导航注册「导入与导出」页面。
 *
 * 页面需要「勾选服务器 / 选择保存路径 / 选择要导入的文件」，这些都不能靠
 * `command` 字符串完成，所以按钮声明 `action`（点击时回调脚本），需要路径的
 * 按钮再加 `pick`（管理器先弹出原生对话框，把选中的路径交给回调）：
 *   mcsm.ui.onAction(pageId, "export-data", fn)   → 按钮点击时调用 fn(info)
 *   info.path                                     → pick 选出的文件 / 目录
 *   mcsm.events.on("ui.selection", fn)            → 可勾选表格的选择变化
 * `pick.mode`：save（另存为）/ open（选择文件）/ dir（选择文件夹）/
 * auto（勾选 1 行时另存为，多行时选文件夹）。
 */
(function () {
    var pluginId = mcsm.plugin.id;
    var pageId = mcsm.ui.registerPage({
        id: "import-export",
        title: "导入与导出",
        icon: "⇄",
        subtitle: "把选中的服务器导出成容器包，或把容器包导入成新服务器"
    });

    var selection = [];        // 勾选的服务器 id，保持点击顺序
    var bundles = [];
    var exportDir = "";
    var lastCount = -1;
    var pendingImport = "";
    var lastResult = "操作结果会显示在这里。导入完成后，服务器列表会在几秒内自动刷新。";

    function command(method) {
        return "plugin call --name " + pluginId + " --method " + method;
    }

    function encodeToken(value) {
        return encodeURIComponent(String(value === undefined || value === null ? "" : value))
            .replace(/~/g, "%7E");
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

    function stampName() {
        var at = new Date();
        function pad(value) { return (value < 10 ? "0" : "") + value; }
        return at.getFullYear() + pad(at.getMonth() + 1) + pad(at.getDate()) + "-"
            + pad(at.getHours()) + pad(at.getMinutes()) + pad(at.getSeconds());
    }

    function clip(text, max) {
        text = String(text || "");
        return text.length > max ? text.slice(0, max - 1) + "…" : text;
    }

    function findServer(servers, id) {
        for (var i = 0; i < servers.length; i++) {
            if (servers[i].id === id) return servers[i];
        }
        return null;
    }

    /// 「A、B、C 等 5 台」——超过三台就省略后面的名字。
    function describeSelection(servers) {
        if (!selection.length) return "";
        var names = [];
        for (var i = 0; i < selection.length; i++) {
            var server = findServer(servers, selection[i]);
            names.push(server ? server.name : selection[i]);
        }
        if (names.length > 3) {
            return names.slice(0, 3).join("、") + " 等 " + names.length + " 台";
        }
        return names.join("、");
    }

    function pruneSelection(servers) {
        var kept = [];
        for (var i = 0; i < selection.length; i++) {
            if (findServer(servers, selection[i])) kept.push(selection[i]);
        }
        selection = kept;
    }

    /// 导出按钮的对话框配置：勾 1 台 → 另存为（带建议文件名），多台 → 选目录。
    function exportPick() {
        var servers = mcsm.servers.list() || [];
        var suggested = "";
        if (selection.length === 1) {
            var server = findServer(servers, selection[0]);
            suggested = (server ? server.name : "server") + "-" + stampName() + ".tar";
        }
        return {
            mode: "auto",
            title: "导出容器包",
            filter: "容器包 (*.tar);;所有文件 (*.*)",
            defaultPath: exportDir,
            defaultName: suggested
        };
    }

    function importPick() {
        return {
            mode: "open",
            title: "选择要导入的容器包",
            filter: "容器包 (*.tar);;所有文件 (*.*)",
            defaultPath: exportDir
        };
    }

    function render() {
        var servers = mcsm.servers.list() || [];
        pruneSelection(servers);
        var current = findServer(servers, mcsm.servers.selected());
        var summary = describeSelection(servers);
        var blocks = [
            { type: "heading", text: "容器搬运工" },
            {
                type: "text",
                style: "hint",
                text: "勾选要搬家的服务器，导出成单个 .tar 包，到另一台机器上再导入即可继续用。"
                    + "导入时会自动分配新的 id 与端口，并直接加入服务器列表。"
            },
            {
                type: "keyvalue",
                items: [
                    ["当前选中服务器", summary
                        ? summary + "（已选 " + selection.length + " 台）"
                        : (current ? current.name + " · 未勾选（在下方表格勾选）" : "（未选择）")],
                    ["默认导出目录", exportDir || "（正在读取…）"]
                ]
            }
        ];

        if (servers.length > 0) {
            var rows = [];
            var rowIds = [];
            for (var i = 0; i < servers.length; i++) {
                rowIds.push(servers[i].id);
                rows.push([servers[i].name, servers[i].type, servers[i].status]);
            }
            blocks.push({
                type: "table",
                title: "服务器",
                columns: ["名称", "类型", "状态"],
                rows: rows,
                selectable: true,
                key: "servers",
                rowIds: rowIds,
                selected: selection
            });
        } else {
            blocks.push({ type: "text", style: "caption", text: "还没有服务器，先在「服务器」页新建一台。" });
        }

        blocks.push({
            type: "buttons",
            items: [
                { label: "导出选中（数据 + 配置）", action: "export-data", pick: exportPick() },
                { label: "导出选中（含容器镜像）", action: "export-image", level: "outline", pick: exportPick() },
                { label: "完整导出（含备份）", action: "export-full", level: "outline", pick: exportPick() }
            ]
        });
        blocks.push({
            type: "text",
            style: "hint",
            text: "只勾选一台时会让你选择保存位置（.tar 文件）；勾选多台时让你选择目录，每台各生成一个包。"
        });

        blocks.push({ type: "divider" });
        blocks.push({ type: "heading", text: "导入容器包" });
        blocks.push({
            type: "text",
            style: "hint",
            text: "只导入你信任来源的 .tar 容器包。来自其他机器的包可能包含可执行数据或容器镜像，首次导入需要再次确认；容器包属于敏感资产，不要公开分享。"
        });
        blocks.push({
            type: "buttons",
            items: [
                { label: "选择容器包导入…", action: "import-pick", pick: importPick() },
                { label: "重新扫描导出目录", action: "rescan", level: "outline" },
                { label: "打开导出目录", action: "open-folder", level: "outline" }
            ]
        });
        if (pendingImport) {
            blocks.push({
                type: "text",
                style: "caption",
                text: "待确认：" + pendingImport + "。继续会信任包内镜像（如有），并允许其声明的 host 运行时。"
            });
            blocks.push({
                type: "buttons",
                items: [
                    { label: "确认信任并继续导入", action: "confirm-import", level: "danger" },
                    { label: "取消本次导入", action: "cancel-import", level: "outline" }
                ]
            });
        }

        if (bundles.length > 0) {
            var bundleRows = [];
            var limit = Math.min(bundles.length, 8);
            for (var j = 0; j < limit; j++) {
                var bundle = bundles[j];
                bundleRows.push([
                    clip(bundle.serverName || bundle.name, 28),
                    humanSize(bundle.sizeBytes),
                    bundle.hasImage ? "含镜像" : "仅数据",
                    localTime(bundle.mtime)
                ]);
            }
            blocks.push({
                type: "table",
                title: "导出目录里的容器包",
                columns: ["服务器", "大小", "内容", "导出时间"],
                rows: bundleRows
            });
            if (bundles.length > limit) {
                blocks.push({ type: "text", style: "caption", text: "只列出最近的 " + limit + " 个包；其余的用「打开导出目录」查看。" });
            }
        }

        blocks.push({ type: "log", title: "执行结果", text: lastResult });
        mcsm.ui.setPageContent(pageId, blocks);
    }

    /// `plugin call` 的输出是 {ok, data:{ok, data, log, error}}：外层是 CLI 的封装，
    /// 插件自己的结果在 reply.data 里。
    function unwrap(reply) {
        var inner = (reply && reply.data) || {};
        if (inner.ok) return { ok: true, data: inner.data || {} };
        var error = inner.error || {};
        return { ok: false, code: error.code || "", message: error.message || (reply && reply.error) || "未知错误" };
    }

    function invoke(method, callback) {
        mcsm.backend.invoke(["plugin", "call", "--name", pluginId, "--method", method], function (reply) {
            callback(unwrap(reply));
        });
    }

    function log(line) {
        lastResult = line;
        render();
    }

    function scan() {
        invoke("scan", function (result) {
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

    function doExport(mode, label, info) {
        if (!selection.length) {
            mcsm.toast("先勾选要导出的服务器", "warn");
            return;
        }
        var servers = mcsm.servers.list() || [];
        var names = describeSelection(servers);
        var target = String((info && info.path) || "");
        if (!target) {
            log(label + "：已取消（没有选择保存位置）。");
            return;
        }
        // 单台导出时对话框要的是文件名，用户可能没写扩展名。
        if (selection.length === 1 && !/\.tar$/i.test(target)) target += ".tar";
        log(label + "：" + names + " …");
        var method = "export~" + selection.map(encodeToken).join(",")
            + "~" + mode + "~" + encodeToken(target);
        invoke(method, function (result) {
            if (!result.ok) {
                mcsm.toast("导出失败：" + result.message, "error");
                log("导出失败：" + result.message);
                return;
            }
            var files = result.data.files || [];
            var lines = [];
            for (var i = 0; i < files.length; i++) {
                lines.push(files[i].name + "（" + humanSize(files[i].sizeBytes) + "）");
            }
            mcsm.toast("已导出 " + files.length + " 个容器包", "success");
            log("导出完成：" + lines.join("、") + " → " + target);
            scan();
        });
    }

    function doImport(info, confirmed) {
        var file = String((info && info.path) || "");
        if (!file) {
            log("导入：已取消（没有选择文件）。");
            return;
        }
        pendingImport = "";
        log("导入中：" + file + " …");
        var method = "import~" + encodeToken(file);
        if (confirmed) method += "~allowHost=1&allowUntrustedImage=1";
        invoke(method, function (result) {
            if (!result.ok) {
                if (result.code === "IMPORT_CONFIRM_REQUIRED") {
                    pendingImport = file;
                    mcsm.toast("该容器包需要额外确认", "warn");
                    log(result.message + " 未执行导入。");
                    return;
                }
                mcsm.toast("导入失败：" + result.message, "error");
                log("导入失败：" + result.message);
                return;
            }
            var data = result.data || {};
            var name = (data.server && data.server.name) || data.name || "新服务器";
            mcsm.toast("已导入「" + name + "」", "success");
            log("导入完成：" + name + (data.ports ? "（端口 " + data.ports.port + "）" : "")
                + "，已加入服务器列表。");
            if (mcsm.refreshServers) mcsm.refreshServers();
            render();
        });
    }

    mcsm.ui.onAction(pageId, "export-data", function (info) { doExport(0, "导出（数据 + 配置）", info); });
    mcsm.ui.onAction(pageId, "export-image", function (info) { doExport(1, "导出（含容器镜像）", info); });
    mcsm.ui.onAction(pageId, "export-full", function (info) { doExport(2, "完整导出（含备份）", info); });
    mcsm.ui.onAction(pageId, "import-pick", doImport);
    mcsm.ui.onAction(pageId, "confirm-import", function () {
        if (pendingImport) doImport({ path: pendingImport }, true);
    });
    mcsm.ui.onAction(pageId, "cancel-import", function () {
        pendingImport = "";
        log("已取消本次导入。");
    });
    mcsm.ui.onAction(pageId, "rescan", scan);
    mcsm.ui.onAction(pageId, "open-folder", function () {
        invoke("open-folder", function (result) {
            log(result.ok ? "已打开导出目录。" : "打开导出目录失败：" + result.message);
        });
    });

    mcsm.events.on("ui.selection", function (payload) {
        if (!payload || payload.pageId !== pageId) return;
        selection = payload.selected || [];
        render();
    });
    mcsm.events.on("server.selected", function () { render(); });
    mcsm.events.on("servers.refreshed", function (payload) {
        var count = payload && typeof payload.count === "number" ? payload.count : -1;
        if (count !== lastCount) {
            lastCount = count;
            render();
        }
    });
    mcsm.events.on("app.ready", function () { scan(); });

    render();
    scan();
})();
