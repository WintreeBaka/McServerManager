/*
 * 玩家管理插件 · 前端（运行在 QJSEngine 中，没有 DOM）
 * ============================================================================
 * 版式（尽量贴近表格，玩家多的时候也容易对应）：
 *
 *   · 名单用真正的表格区块（table）展示，列对齐：玩家 / 白名单 / 管理员 / 封禁
 *   · 在线玩家与已知玩家按「一名玩家一行」排列：先一行玩家名，紧接着一行是
 *     这名玩家自己的操作按钮，不会再出现「10 排按钮里横向找玩家」的问题
 *   · 名单类操作（移出白名单 / 取消 OP / 解封）跟在对应表格后面，按钮只写名字
 *
 * 原生页面没有文本输入框，所以按钮命令必须是一个不含空格和引号的参数：把
 * 「动作 / 服务器 / 玩家 / 文本」百分号编码后塞进 --method：
 *     plugin call --name com.mcsm.player-admin --method run|kick|survival|Steve
 *
 * 需要自定义文案（标题内容、踢出/封禁理由、私信）时改插件数据目录里的
 * texts.json，按钮会用新文案；数据中心约每 20 秒自动刷新一次。
 * ============================================================================
 */
(function () {
    var PLUGIN_ID = mcsm.plugin.id;
    var PAGE_ID = "player-admin";
    var MAX_ITEMS = 12;      // 名单按钮行上限，超出部分请在表格里对照人名字符串操作

    var pageId = mcsm.ui.registerPage({
        id: PAGE_ID,
        title: "玩家管理",
        icon: "⚔",
        subtitle: "白名单 / 黑名单 / OP 名单 与玩家操作"
    });

    var state = {
        server: "",
        data: null,
        error: "",
        signature: ""
    };

    // ---------------------------------------------------------------- 工具 ----

    /// 把任意文本编码成「无空格、无引号、无百分号歧义」的参数字段。
    function enc(value) {
        var text = (value === undefined || value === null) ? "" : String(value);
        var bytes = [];
        for (var i = 0; i < text.length; i++) {
            var code = text.charCodeAt(i);
            if (code < 0x80) {
                bytes.push(code);
            } else if (code < 0x800) {
                bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
            } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
                       && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
                var pair = 0x10000 + ((code - 0xd800) << 10) + (text.charCodeAt(i + 1) - 0xdc00);
                bytes.push(0xf0 | (pair >> 18), 0x80 | ((pair >> 12) & 0x3f),
                           0x80 | ((pair >> 6) & 0x3f), 0x80 | (pair & 0x3f));
                i++;
            } else {
                bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
            }
        }
        var out = "";
        for (var j = 0; j < bytes.length; j++) {
            var byte = bytes[j];
            if ((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90)
                || (byte >= 97 && byte <= 122) || byte === 45 || byte === 46 || byte === 95) {
                out += String.fromCharCode(byte);
            } else {
                out += "%" + (byte < 16 ? "0" : "") + byte.toString(16).toUpperCase();
            }
        }
        return out;
    }

    /// 生成一个「按钮可执行」的插件命令。
    function command(action, server, player, value, value2) {
        var method = "run|" + enc(action) + "|" + enc(server) + "|" + enc(player)
                     + "|" + enc(value);
        if (value2 !== undefined && value2 !== null && String(value2).length) {
            method += "|" + enc(value2);
        }
        return "plugin call --name " + PLUGIN_ID + " --method " + method;
    }

    function button(label, action, server, player, value, value2, tone, glyph, toast) {
        return {
            label: label,
            icon: glyph || "",
            level: tone || "primary",
            command: command(action, server, player, value, value2),
            toast: toast || (label + (player ? "：" + player : ""))
        };
    }

    /// 调用后端方法。插件返回的 data 会被 mcsm-cli 再包一层，所以取 reply.data.data。
    function call(method, params, done) {
        var args = ["plugin", "call", "--name", PLUGIN_ID, "--method", method];
        if (params) {
            args.push("--params", JSON.stringify(params));
        }
        mcsm.backend.invoke(args, function (reply) {
            if (!reply.ok) {
                done(null, reply.error || "后端调用失败");
                return;
            }
            var payload = reply.data && reply.data.data ? reply.data.data : reply.data;
            done(payload || {}, "");
        });
    }

    function nameOf(entry) {
        return entry && entry.name ? String(entry.name) : "";
    }

    function names(list) {
        var out = [];
        for (var i = 0; i < (list || []).length; i++) {
            if (list[i] && list[i].name) {
                out.push(String(list[i].name));
            }
        }
        return out;
    }

    function trimmed(list) {
        return list.length > MAX_ITEMS ? list.slice(0, MAX_ITEMS) : list;
    }

    function mark(flag) {
        return flag ? "✔" : "—";
    }

    function signatureOf(data) {
        if (!data || !data.server) {
            return "none";
        }
        return JSON.stringify([
            data.server.id, data.server.status, data.rcon ? data.rcon.ok : false,
            data.online ? data.online.names : [], names(data.whitelist), names(data.ops),
            names(data.banned), names(data.known),
            data.properties ? data.properties["white-list"] : false,
            data.texts ? data.texts.title : ""
        ]);
    }

    // ---------------------------------------------------------------- 渲染 ----

    /// 一名玩家的操作按钮行（只放与他相关的动作，避免整页重复无用按钮）。
    function actionsForPlayer(player, ctx) {
        var items = [];
        var texts = ctx.texts || {};
        items.push(button("踢出", "kick", ctx.server, player, texts.kickReason, "", "primary", "⇱"));
        items.push(button("封禁", "ban", ctx.server, player, texts.banReason, "", "danger", "⛔"));
        items.push(button("标题", "title", ctx.server, player, texts.title, texts.subtitle, "primary", "❖"));
        items.push(button("私信", "tell", ctx.server, player, texts.tell, "", "primary", "✉"));
        if (ctx.whitelist[player]) {
            items.push(button("移出白名单", "whitelistRemove", ctx.server, player, "", "", "outline", "－"));
        } else {
            items.push(button("加入白名单", "whitelistAdd", ctx.server, player, "", "", "primary", "＋"));
        }
        if (ctx.ops[player]) {
            items.push(button("取消 OP", "deop", ctx.server, player, "", "", "outline", "☆"));
        } else {
            items.push(button("设为 OP", "op", ctx.server, player, "", "", "primary", "★"));
        }
        items.push(button("生存模式", "gamemode", ctx.server, player, "survival", "", "outline", "◈"));
        items.push(button("创造模式", "gamemode", ctx.server, player, "creative", "", "outline", "◈"));
        return items;
    }

    /// 玩家名行：名字醒目、后面跟状态标记，相当于表格的一行。
    function playerCaption(player, flags) {
        var text = player;
        if (flags && flags.length) {
            text += "　｜　" + flags.join(" · ");
        }
        return { type: "text", style: "subtitle", text: text };
    }

    function flagList(entry, ctx) {
        var flags = [];
        if (ctx.whitelist[entry]) { flags.push("白名单"); }
        if (ctx.ops[entry]) { flags.push("管理员"); }
        if (ctx.banned[entry]) { flags.push("已封禁"); }
        return flags;
    }

    function playerGroups(players, ctx) {
        var blocks = [];
        var shown = trimmed(players);
        for (var i = 0; i < shown.length; i++) {
            blocks.push(playerCaption(shown[i], flagList(shown[i], ctx)));
            blocks.push({ type: "buttons", items: actionsForPlayer(shown[i], ctx) });
        }
        if (players.length > shown.length) {
            blocks.push({ type: "text", style: "hint",
                          text: "只列出前 " + shown.length + " 位，其余可用表格对照玩家名后另行处理。" });
        }
        return blocks;
    }

    function removeRow(label, action, entries, ctx, glyph) {
        var blocks = [];
        var list = entries;
        if (!list.length) {
            return blocks;
        }
        var items = [];
        var shown = trimmed(list);
        for (var i = 0; i < shown.length; i++) {
            items.push(button(shown[i], action, ctx.server, shown[i], "", "", "outline", glyph,
                              label + "：" + shown[i]));
        }
        blocks.push({ type: "text", style: "caption", text: label + "（点击玩家名）" });
        blocks.push({ type: "buttons", items: items });
        if (list.length > shown.length) {
            blocks.push({ type: "text", style: "hint",
                          text: "名单较长，只列出前 " + shown.length + " 位，其余请在「控制台」页处理。" });
        }
        return blocks;
    }

    function tableBlock(columns, rows, title) {
        var block = { type: "table", columns: columns, rows: rows };
        if (title) {
            block.title = title;
        }
        return block;
    }

    function render() {
        var blocks = [];
        var data = state.data;

        blocks.push({ type: "heading", text: "玩家管理" });
        blocks.push({
            type: "text",
            style: "hint",
            text: "先在「服务器」页选中要管理的服务器，再回到本页。数据约每 20 秒自动刷新；"
                + "每个玩家名下面的一排按钮就是对他的操作，文案（标题 / 理由 / 私信）在页面底部的 "
                + "texts.json 里改。"
        });

        if (state.error) {
            blocks.push({ type: "text", style: "caption", text: "读取失败：" + state.error });
        }
        if (!data) {
            blocks.push({ type: "text", style: "hint", text: "正在读取服务器状态…" });
            mcsm.ui.setPageContent(pageId, blocks);
            return;
        }
        if (!data.server) {
            var summaries = data.servers || [];
            var lines = [];
            for (var s = 0; s < summaries.length; s++) {
                lines.push((summaries[s].name || summaries[s].id) + "（" + summaries[s].id + "）");
            }
            blocks.push({ type: "text", style: "caption",
                          text: lines.length ? "管理器里已有服务器：" + lines.join("、")
                                             : "管理器里还没有服务器。" });
            blocks.push({ type: "text", style: "hint",
                          text: "请先在「服务器」页创建或选中一台服务器。" });
            mcsm.ui.setPageContent(pageId, blocks);
            return;
        }

        var server = data.server.id;
        var online = data.online || { names: [], count: 0, max: null };
        var rconOk = data.rcon ? data.rcon.ok : false;
        var whitelist = data.whitelist || [];
        var ops = data.ops || [];
        var banned = data.banned || [];
        var known = data.known || [];
        var texts = data.texts || {};

        var ctx = {
            server: server,
            whitelist: {},
            ops: {},
            banned: {},
            texts: texts
        };
        for (var i1 = 0; i1 < whitelist.length; i1++) {
            ctx.whitelist[nameOf(whitelist[i1]).toLowerCase()] = true;
        }
        for (var i2 = 0; i2 < ops.length; i2++) {
            ctx.ops[nameOf(ops[i2]).toLowerCase()] = true;
        }
        for (var i3 = 0; i3 < banned.length; i3++) {
            ctx.banned[nameOf(banned[i3]).toLowerCase()] = true;
        }

        blocks.push({ type: "keyvalue", items: [
            ["服务器", (data.server.name || server) + "（" + server + "）"],
            ["类型 / 版本", (data.server.type || "-") + " / " + (data.server.mcVersion || "-")],
            ["运行状态", (data.server.running ? "运行中" : "已停止")
                         + (rconOk ? " · RCON 可用" : " · RCON 不可用")],
            ["在线玩家", online.count + (online.max ? " / " + online.max : "")],
            ["白名单", whitelist.length + " 人"
                       + (data.properties && data.properties["white-list"] ? "（已开启）" : "（已关闭）")],
            ["OP 管理员", ops.length + " 人"],
            ["封禁名单", banned.length + " 人"]
        ] });

        var warns = data.warnings || [];
        for (var w = 0; w < warns.length; w++) {
            blocks.push({ type: "text", style: "hint", text: "提示：" + warns[w] });
        }

        // ------------------------------------------------- 在线玩家（一行一人） ----
        blocks.push({ type: "divider" });
        blocks.push({ type: "heading", text: "在线玩家（" + online.names.length + " 人）" });
        if (online.names.length) {
            var onlineRows = [];
            for (var p = 0; p < online.names.length; p++) {
                var name = online.names[p];
                var key = name.toLowerCase();
                onlineRows.push([name, mark(ctx.whitelist[key]), mark(ctx.ops[key]),
                                 ctx.banned[key] ? "是" : "—"]);
            }
            blocks.push(tableBlock(["玩家", "白名单", "管理员", "封禁"], onlineRows));
            blocks.push({ type: "text", style: "caption",
                          text: "对在线玩家执行操作（一名玩家一行，按钮只作用于该玩家）" });
            var groups = playerGroups(online.names, ctx);
            for (var g = 0; g < groups.length; g++) {
                blocks.push(groups[g]);
            }
        } else {
            blocks.push({
                type: "text",
                style: "hint",
                text: rconOk ? "当前没有玩家在线。" : "无法读取在线玩家：服务器未运行或 RCON 不可用。"
            });
        }

        // ---------------------------------------------------------------- 白名单 ----
        blocks.push({ type: "divider" });
        blocks.push({ type: "heading", text: "白名单（" + whitelist.length + " 人）" });
        if (whitelist.length) {
            var wlRows = [];
            for (var i4 = 0; i4 < whitelist.length; i4++) {
                var wlName = nameOf(whitelist[i4]);
                wlRows.push([wlName, online.names.indexOf(wlName) >= 0 ? "在线" : "离线",
                             whitelist[i4].uuid || "-"]);
            }
            blocks.push(tableBlock(["玩家", "状态", "UUID"], wlRows));
            var wlButtons = removeRow("移出白名单", "whitelistRemove", names(whitelist), ctx, "－");
            for (var r1 = 0; r1 < wlButtons.length; r1++) {
                blocks.push(wlButtons[r1]);
            }
        } else {
            blocks.push({ type: "text", style: "hint", text: "白名单为空。" });
        }
        blocks.push({ type: "buttons", items: [
            button("开启白名单", "whitelistOn", server, "", "", "", "primary", "▣", "已请求开启白名单"),
            button("关闭白名单", "whitelistOff", server, "", "", "", "outline", "▢", "已请求关闭白名单"),
            button("重载白名单文件", "whitelistReload", server, "", "", "", "outline", "⟳", "已请求重载白名单")
        ] });

        // ------------------------------------------------------------------- OP ----
        blocks.push({ type: "divider" });
        blocks.push({ type: "heading", text: "OP 管理员（" + ops.length + " 人）" });
        if (ops.length) {
            var opRows = [];
            for (var i5 = 0; i5 < ops.length; i5++) {
                var opName = nameOf(ops[i5]);
                opRows.push([opName, String(ops[i5].level || 4),
                             online.names.indexOf(opName) >= 0 ? "在线" : "离线"]);
            }
            blocks.push(tableBlock(["管理员", "等级", "状态"], opRows));
            var opButtons = removeRow("取消 OP", "deop", names(ops), ctx, "☆");
            for (var r2 = 0; r2 < opButtons.length; r2++) {
                blocks.push(opButtons[r2]);
            }
        } else {
            blocks.push({ type: "text", style: "hint", text: "还没有管理员。" });
        }

        // -------------------------------------------------------------- 封禁名单 ----
        blocks.push({ type: "divider" });
        blocks.push({ type: "heading", text: "封禁名单（" + banned.length + " 人）" });
        if (banned.length) {
            var banRows = [];
            for (var i6 = 0; i6 < banned.length; i6++) {
                banRows.push([nameOf(banned[i6]), banned[i6].reason || "-", banned[i6].expires || "-"]);
            }
            blocks.push(tableBlock(["玩家", "原因", "到期"], banRows));
            var banButtons = removeRow("解除封禁", "unban", names(banned), ctx, "✔");
            for (var r3 = 0; r3 < banButtons.length; r3++) {
                blocks.push(banButtons[r3]);
            }
        } else {
            blocks.push({ type: "text", style: "hint", text: "封禁名单为空。" });
        }

        // -------------------------------------------------------- 已知玩家（离线） ----
        var knownToShow = [];
        for (var i7 = 0; i7 < known.length; i7++) {
            var kName = nameOf(known[i7]);
            if (!kName) {
                continue;
            }
            if (ctx.whitelist[kName.toLowerCase()] && ctx.ops[kName.toLowerCase()]
                && ctx.banned[kName.toLowerCase()]) {
                continue;
            }
            knownToShow.push(kName);
        }
        blocks.push({ type: "divider" });
        blocks.push({ type: "heading", text: "已知玩家（可离线管理）" });
        blocks.push({
            type: "text",
            style: "hint",
            text: "来自 usercache.json（曾进入过服务器的玩家）。服务器未运行时名单操作会直接写入名单文件，"
                + "重启后生效；正版模式若查不到 UUID 会给出提示。"
        });
        if (knownToShow.length) {
            var knownRows = [];
            var shownKnown = trimmed(knownToShow);
            for (var i8 = 0; i8 < shownKnown.length; i8++) {
                var uuids = "";
                for (var i9 = 0; i9 < known.length; i9++) {
                    if (nameOf(known[i9]) === shownKnown[i8]) {
                        uuids = known[i9].uuid || "-";
                    }
                }
                knownRows.push([shownKnown[i8], mark(ctx.whitelist[shownKnown[i8].toLowerCase()]),
                                mark(ctx.ops[shownKnown[i8].toLowerCase()]),
                                mark(ctx.banned[shownKnown[i8].toLowerCase()]), uuids]);
            }
            blocks.push(tableBlock(["玩家", "白名单", "管理员", "封禁", "UUID"], knownRows));
            blocks.push({ type: "text", style: "caption", text: "对已知玩家执行操作（一名玩家一行）" });
            for (var k = 0; k < shownKnown.length; k++) {
                var person = shownKnown[k];
                var items = [];
                if (!ctx.whitelist[person.toLowerCase()]) {
                    items.push(button("加入白名单", "whitelistAdd", server, person, "", "", "primary", "＋"));
                } else {
                    items.push(button("移出白名单", "whitelistRemove", server, person, "", "", "outline", "－"));
                }
                if (!ctx.ops[person.toLowerCase()]) {
                    items.push(button("设为 OP", "op", server, person, "", "", "primary", "★"));
                } else {
                    items.push(button("取消 OP", "deop", server, person, "", "", "outline", "☆"));
                }
                if (!ctx.banned[person.toLowerCase()]) {
                    items.push(button("封禁", "ban", server, person, texts.banReason, "", "danger", "⛔"));
                } else {
                    items.push(button("解封", "unban", server, person, "", "", "outline", "✔"));
                }
                blocks.push(playerCaption(person, flagList(person, ctx)));
                blocks.push({ type: "buttons", items: items });
            }
            if (knownToShow.length > shownKnown.length) {
                blocks.push({ type: "text", style: "hint",
                              text: "只列出前 " + shownKnown.length + " 位，其余可用表格对照名字后另行处理。" });
            }
        } else {
            blocks.push({ type: "text", style: "hint", text: "没有可管理的已知玩家。" });
        }

        // -------------------------------------------------------------- 文案设置 ----
        blocks.push({ type: "divider" });
        blocks.push({ type: "heading", text: "按钮文案（可自定义）" });
        blocks.push({ type: "keyvalue", items: [
            ["标题", texts.title || "（空）"],
            ["副标题", texts.subtitle || "（空）"],
            ["踢出理由", texts.kickReason || "（空）"],
            ["封禁理由", texts.banReason || "（空）"],
            ["私信内容", texts.tell || "（空）"]
        ] });
        blocks.push({
            type: "text",
            style: "hint",
            text: "改这个文件即可（UTF-8，保存后约 20 秒生效）：" + (data.textsPath || "")
                + "\n需要一次性发送别的文本时，也可以在「控制台」页直接发 /title、/kick 等原版指令。"
        });

        // ---------------------------------------------------------------- 输出 ----
        blocks.push({ type: "divider" });
        blocks.push({
            type: "log",
            title: "操作输出",
            text: "按钮执行的命令与结果会追加到这里。"
        });

        mcsm.ui.setPageContent(pageId, blocks);
    }

    // ---------------------------------------------------------------- 数据 ----

    function fetch(forceRender) {
        var want = state.server || mcsm.servers.selected() || "";
        call("dashboard", want ? { server: want } : null, function (data, error) {
            if (error || !data) {
                state.error = error || "未知错误";
                render();
                return;
            }
            state.error = "";
            state.data = data;
            if (data.server) {
                state.server = data.server.id;
            }
            var next = signatureOf(data);
            if (forceRender || next !== state.signature) {
                state.signature = next;
                render();
            }
        });
    }

    // 用户在「服务器」页切换服务器时重新读取
    mcsm.events.on("server.selected", function (payload) {
        var id = payload && payload.serverId ? String(payload.serverId) : "";
        if (id) {
            state.server = id;
        }
        fetch(true);
    });

    // 管理器刷新服务器列表后同步一次（只有内容变化才重绘）
    mcsm.events.on("servers.refreshed", function () {
        fetch(false);
    });

    // 管理器约每 20 秒派发一次环境刷新事件，正好可以当定时器用：重新拉一次快照，
    // 内容真的变了才重绘（重绘会清空输出框）。
    mcsm.events.on("environment.changed", function () {
        fetch(false);
    });

    mcsm.events.on("app.ready", function () {
        fetch(true);
    });

    fetch(true);
    mcsm.log("player-admin 前端已加载");
})();
