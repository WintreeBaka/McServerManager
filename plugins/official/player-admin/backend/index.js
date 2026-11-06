"use strict";

/*
 * 玩家管理插件 · 后端（JSON-Line 协议）
 * ============================================================================
 * 管理器每调用一次方法就会拉起一个本进程：从 stdin 读一行 JSON 请求，把一行
 * JSON 结果写到 stdout。真正的工作都交给 lib/mcsm.js。
 *
 * 支持的方法：
 *   health / info                     自检与能力自描述
 *   dashboard  {server?}              整页快照（服务器、在线玩家、三份名单）
 *   act        {server?, action, ...} 执行一个玩家操作
 *   run|<action>|<server>|<player>|<value>|<value2>
 *                                     按钮专用：原生页面没有参数输入框，按钮只能
 *                                     输出一条不含空格与引号的命令，因此把参数
 *                                     百分号编码后塞进方法名。
 *   钩子：plugin.install / plugin.enable / plugin.disable / plugin.uninstall
 *         server.afterStart / server.afterStop
 * ============================================================================
 */

const readline = require("readline");
const core = require("./lib/mcsm");

const PLUGIN_ID = "com.mcsm.player-admin";
const PLUGIN_VERSION = "1.0.0";

function reply(object) {
    process.stdout.write(JSON.stringify(object) + "\n");
}

function fail(code, message, detail) {
    return { ok: false, error: { code: code, message: message, detail: detail || "" } };
}

function decodeField(value) {
    try {
        return decodeURIComponent(String(value === undefined || value === null ? "" : value));
    } catch (error) {
        return String(value === undefined || value === null ? "" : value);
    }
}

/// "run|kick|survival|Steve|%E7%90%86%E7%94%B1" -> { action, server, ... }
function parseMethod(method) {
    const parts = String(method || "").split("|");
    if (parts[0] !== "run") {
        return null;
    }
    return {
        action: decodeField(parts[1]),
        server: decodeField(parts[2]),
        player: decodeField(parts[3]),
        value: decodeField(parts[4]),
        value2: decodeField(parts[5])
    };
}

async function handle(request) {
    const params = request.params && typeof request.params === "object" ? request.params : {};
    const root = core.resolveRoot({ pluginsDir: request.pluginsDir, dataDir: request.dataDir });

    switch (request.method) {
    case "health":
        return { ok: true, data: { ok: true, plugin: PLUGIN_ID, version: PLUGIN_VERSION, root: root } };

    case "info":
    case "describe":
        return {
            ok: true,
            data: {
                name: "玩家管理",
                id: PLUGIN_ID,
                version: PLUGIN_VERSION,
                capabilities: ["dashboard", "act", "lists", "hooks",
                               "whitelist", "banned", "ops", "title", "kick", "ban"],
                actions: Object.keys(core.ACTIONS)
            }
        };

    case "dashboard":
    case "lists": {
        const data = await core.buildDashboard(root, params.server || params.id || "",
                                               { dataDir: request.dataDir });
        return { ok: true, data: data, warnings: data.warnings };
    }

    case "texts": {
        // 读取 / 覆盖 texts.json 里的文案（用户也可以直接用记事本改那个文件）
        if (params && params.set && typeof params.set === "object") {
            const texts = core.saveTexts(root, request.dataDir, params.set);
            return { ok: true, data: { texts: texts, path: core.loadTexts(root, request.dataDir).path } };
        }
        const current = core.loadTexts(root, request.dataDir);
        return { ok: true, data: { texts: current.texts, path: current.path, source: current.source } };
    }

    case "act":
    case "do": {
        const servers = core.loadServers(root);
        const record = core.findServer(servers, params.server || "");
        const result = await core.performAction(root, record, String(params.action || ""),
                                                params.player, params.value !== undefined ? params.value : params.reason,
                                                params.value2, { dataDir: request.dataDir });
        if (!result.ok) {
            return { ok: false, error: { code: "ACTION_FAILED", message: result.message,
                                         detail: result.response }, data: result };
        }
        return { ok: true, data: result, warnings: result.warnings };
    }

    case "plugin.install":
    case "plugin.enable":
        return { ok: true, data: { acknowledged: true },
                 log: ["玩家管理插件已就绪，请到「服务器」页选中目标服务器后打开插件页面"] };

    case "plugin.disable":
    case "plugin.uninstall":
        return { ok: true, data: { acknowledged: true },
                 log: ["玩家管理插件已停用（网页面板服务如需关闭请执行 plugin service stop）"] };

    case "server.afterStart": {
        const server = (params.server || {}).id || "";
        return { ok: true, data: { event: "server.afterStart", server: server },
                 log: ["server " + server + " started"] };
    }

    case "server.afterStop": {
        const server = (params.server || {}).id || "";
        return { ok: true, data: { event: "server.afterStop", server: server },
                 log: ["server " + server + " stopped"] };
    }

    default:
        break;
    }

    const encoded = parseMethod(request.method);
    if (encoded) {
        const servers = core.loadServers(root);
        const record = core.findServer(servers, encoded.server);
        const result = await core.performAction(root, record, encoded.action, encoded.player,
                                                encoded.value, encoded.value2,
                                                { dataDir: request.dataDir });
        if (!result.ok) {
            return { ok: false, error: { code: "ACTION_FAILED", message: result.message,
                                         detail: result.response }, data: result };
        }
        return { ok: true, data: result, warnings: result.warnings };
    }

    return fail("METHOD_NOT_FOUND", "未实现的方法：" + request.method);
}

const reader = readline.createInterface({ input: process.stdin, terminal: false });
reader.on("line", (line) => {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
        return;
    }
    let request = {};
    try {
        request = JSON.parse(trimmed);
    } catch (error) {
        reply(fail("BAD_JSON", "无法解析请求：" + error.message));
        return;
    }
    Promise.resolve()
        .then(() => handle(request))
        .then((result) => {
            reply(result);
        })
        .catch((error) => {
            reply(fail("PLUGIN_ERROR", error && error.message ? error.message : String(error),
                       error && error.stack ? error.stack : ""));
        });
});
