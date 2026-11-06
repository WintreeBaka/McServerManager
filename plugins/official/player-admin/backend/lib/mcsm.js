"use strict";

/*
 * 玩家管理插件 · 共享核心
 * ============================================================================
 * 后端插件进程（backend/index.js）的逻辑都在这里，前端页面通过 plugin call
 * 调用它。这里只做四件事：
 *
 *   1. 定位管理器的数据根目录（servers.json 所在目录）
 *   2. 读取服务器记录与服务器目录里的名单文件
 *      （whitelist.json / ops.json / banned-players.json / usercache.json /
 *        server.properties）
 *   3. 一个纯 Node 的 RCON 客户端（不依赖 mcsm-cli，也不依赖 Docker）
 *   4. 具体的玩家操作：踢出 / 封禁 / 解封 / OP / 白名单 / 标题 / 私信 / 模式 …
 *
 * 设计约定：
 *   · 服务器运行时优先走 RCON（由服务端自己写名单文件，正版 UUID 正确）；
 *   · 服务器停止时退化为直接编辑名单文件，并在 warnings 里说明注意事项。
 * ============================================================================
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const https = require("https");

const RCON_HOST = "127.0.0.1";
const RCON_TIMEOUT_MS = 6000;

/// 本插件自己的 id（用于定位数据目录里的文案文件）。
const PLUGIN_ID = "com.mcsm.player-admin";

/// 默认文案：和「发送标题 / 私信 / 踢出 / 封禁」这些按钮配套。
/// 原生插件页面没有文本输入框，所以文案放在数据目录的 texts.json 里，
/// 用户用记事本改一次，页面按钮与命令都会跟着用新文案。
const DEFAULT_TEXTS = {
    title: "欢迎回来",
    subtitle: "",
    kickReason: "违反服务器规则",
    banReason: "违反服务器规则",
    tell: "请注意服务器规则"
};

// ------------------------------------------------------------------ 路径 ----

/// 管理器默认数据根目录：Windows 是 %LOCALAPPDATA%\McServerManager，
/// 其它平台按 XDG 习惯取 ~/.local/share/McServerManager。
function defaultRoot() {
    if (process.platform === "win32") {
        // mcsm-cli uses QStandardPaths::GenericDataLocation, which is
        // %LOCALAPPDATA% on Windows (not the roaming profile).
        const appData = process.env.LOCALAPPDATA
            || path.join(os.homedir(), "AppData", "Local");
        return path.join(appData, "McServerManager");
    }
    return path.join(os.homedir(), ".local", "share", "McServerManager");
}

/// 数据根目录 = 包含 servers.json / plugins / servers 的那个目录。
///
/// 优先用管理器在调用后端插件时直接给出的 pluginsDir / dataDir
/// （它们已经反映了 `--home` / MCSM_HOME 的覆盖），其次才是环境变量。
function resolveRoot(options) {
    const opts = options || {};
    const candidates = [];

    if (opts.pluginsDir) {
        candidates.push(path.dirname(path.resolve(opts.pluginsDir)));
    }
    if (opts.dataDir) {
        // <root>/plugins/.data/<id>
        candidates.push(path.resolve(opts.dataDir, "..", "..", ".."));
    }
    if (process.env.MCSM_HOME) {
        candidates.push(path.resolve(process.env.MCSM_HOME));
    }
    if (process.env.MCSM_PLUGIN_DIR) {
        // <root>/plugins/<id>
        candidates.push(path.resolve(process.env.MCSM_PLUGIN_DIR, "..", ".."));
    }
    if (process.env.MCSM_PLUGIN_DATA) {
        candidates.push(path.resolve(process.env.MCSM_PLUGIN_DATA, "..", "..", ".."));
    }
    candidates.push(defaultRoot());

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return path.resolve(candidate);
        }
    }
    return path.resolve(candidates[candidates.length - 1]);
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        return fallback;
    }
}

function readText(file) {
    try {
        return fs.readFileSync(file, "utf8");
    } catch (error) {
        return "";
    }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/// servers.json 是 `{ version, updatedAt, servers: [...] }`，也兼容裸数组。
function loadServers(root) {
    const document = readJson(path.join(root, "servers.json"), null);
    let list = [];
    if (Array.isArray(document)) {
        list = document;
    } else if (document && Array.isArray(document.servers)) {
        list = document.servers;
    }
    return list.filter((entry) => entry && entry.id);
}

function serverDir(root, record) {
    if (record && record.dir) {
        return record.dir;
    }
    return path.join(root, "servers", record ? String(record.id) : "");
}

function serverFile(root, record, name) {
    return path.join(serverDir(root, record), name);
}

function pluginDataDir(root, dataDir) {
    if (dataDir) {
        return dataDir;
    }
    return path.join(root, "plugins", ".data", PLUGIN_ID);
}

/// 读取文案配置；文件不存在时按默认值创建一份，方便用户直接打开编辑。
function loadTexts(root, dataDir) {
    const file = path.join(pluginDataDir(root, dataDir), "texts.json");
    let stored = null;
    if (fs.existsSync(file)) {
        stored = readJson(file, null);
    } else {
        try {
            writeJson(file, DEFAULT_TEXTS);
            stored = DEFAULT_TEXTS;
        } catch (error) {
            stored = null;
        }
    }
    const texts = {};
    Object.keys(DEFAULT_TEXTS).forEach((key) => {
        const value = stored && typeof stored[key] === "string" ? stored[key] : DEFAULT_TEXTS[key];
        texts[key] = value;
    });
    return { texts: texts, path: file, source: stored ? "file" : "default" };
}

function saveTexts(root, dataDir, values) {
    const current = loadTexts(root, dataDir);
    const next = Object.assign({}, current.texts);
    Object.keys(DEFAULT_TEXTS).forEach((key) => {
        if (values && typeof values[key] === "string") {
            next[key] = values[key];
        }
    });
    writeJson(current.path, next);
    return next;
}

/// 按 id / 名称查找服务器；没指定时优先取正在运行的那台，否则取第一台。
function findServer(servers, want) {
    if (!servers.length) {
        return null;
    }
    if (want) {
        const needle = String(want).toLowerCase();
        const byId = servers.find((entry) => String(entry.id).toLowerCase() === needle);
        if (byId) {
            return byId;
        }
        const byName = servers.find((entry) => String(entry.name || "").toLowerCase() === needle);
        if (byName) {
            return byName;
        }
    }
    return servers.find((entry) => entry.status === "running") || servers[0];
}

function summarize(record) {
    if (!record) {
        return null;
    }
    return {
        id: record.id,
        name: record.name || record.id,
        type: record.type || "",
        mcVersion: record.mcVersion || "",
        status: record.status || "unknown",
        running: record.status === "running",
        port: record.port || 0,
        rconPort: record.rconPort || 0,
        memory: record.memory || ""
    };
}

// ------------------------------------------------------------------ 名单 ----

function readList(root, record, name) {
    const value = readJson(serverFile(root, record, name), []);
    return Array.isArray(value) ? value : [];
}

function writeList(root, record, name, list) {
    writeJson(serverFile(root, record, name), list);
}

function readProperties(root, record) {
    const text = readText(serverFile(root, record, "server.properties"));
    const map = {};
    text.split(/\r?\n/).forEach((line) => {
        const match = /^\s*([^#!\s][^=]*)=(.*)$/.exec(line);
        if (match) {
            map[match[1].trim()] = match[2];
        }
    });
    return map;
}

/// 保留注释地把单个键写回 server.properties（文件不存在时创建）。
function writeProperty(root, record, key, value) {
    const file = serverFile(root, record, "server.properties");
    let lines = readText(file).split(/\r?\n/);
    if (lines.length === 1 && lines[0] === "") {
        lines = [];
    }
    let replaced = false;
    for (let i = 0; i < lines.length; i += 1) {
        const match = /^\s*([^#!\s][^=]*)=/.exec(lines[i]);
        if (match && match[1].trim() === key) {
            lines[i] = key + "=" + value;
            replaced = true;
        }
    }
    if (!replaced) {
        lines.push(key + "=" + value);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join("\n").replace(/\n+$/, "") + "\n", "utf8");
}

function nameOf(entry) {
    return entry && entry.name ? String(entry.name) : "";
}

function uuidOf(entry) {
    return entry && entry.uuid ? String(entry.uuid) : "";
}

function formatUuid(bytes) {
    const hex = bytes.toString("hex");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)]
        .join("-");
}

/// 离线模式（online-mode=false）下，Minecraft 用 "OfflinePlayer:<名字>" 的 MD5
/// 作为玩家 UUID（版本位 3）。正版模式下这个名字对应的 UUID 不同，因此调用方
/// 需要先确认 online-mode。
function offlineUuid(name) {
    const hash = crypto.createHash("md5").update("OfflinePlayer:" + name, "utf8").digest();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    return formatUuid(hash);
}

function withDashes(raw) {
    const hex = String(raw || "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (hex.length !== 32) {
        return "";
    }
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)]
        .join("-");
}

/// 依次查找：本地缓存 -> Mojang 档案接口 -> 离线 UUID。
/// 返回 { uuid, source }，source 用于把不确定性写进 warnings。
async function resolveUuid(root, record, name, options) {
    const opts = options || {};

    const localFiles = ["usercache.json", "whitelist.json", "ops.json", "banned-players.json"];
    for (const file of localFiles) {
        const hit = readList(root, record, file)
            .find((entry) => nameOf(entry).toLowerCase() === name.toLowerCase());
        if (hit && uuidOf(hit)) {
            return { uuid: uuidOf(hit), source: "cache:" + file };
        }
    }

    const properties = readProperties(root, record);
    const onlineMode = String(properties["online-mode"] || "true").toLowerCase() !== "false";
    if (!onlineMode) {
        return { uuid: offlineUuid(name), source: "offline" };
    }

    if (opts.network !== false) {
        const remote = await mojangUuid(name);
        if (remote) {
            return { uuid: remote, source: "mojang" };
        }
    }
    return { uuid: offlineUuid(name), source: "offline-guess" };
}

function mojangUuid(name) {
    return new Promise((resolve) => {
        const request = https.request(
            {
                host: "api.mojang.com",
                path: "/users/profiles/minecraft/" + encodeURIComponent(name),
                method: "GET",
                timeout: 2500
            },
            (response) => {
                let text = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => { text += chunk; });
                response.on("end", () => {
                    const parsed = readJsonText(text);
                    resolve(parsed && parsed.id ? withDashes(parsed.id) : "");
                });
            }
        );
        request.on("timeout", () => { request.destroy(); resolve(""); });
        request.on("error", () => resolve(""));
        request.end();
    });
}

function readJsonText(text) {
    try {
        return JSON.parse(text);
    } catch (error) {
        return null;
    }
}

// ------------------------------------------------------------------ RCON ----

function buildPacket(id, type, text) {
    const body = Buffer.from(text, "utf8");
    const packet = Buffer.alloc(14 + body.length);
    packet.writeInt32LE(body.length + 10, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    body.copy(packet, 12);
    packet.writeInt8(0, 12 + body.length);
    packet.writeInt8(0, 13 + body.length);
    return packet;
}

/// 发一条 RCON 指令并返回文本响应。失败时 reject(Error)。
async function rconExec(record, command, options) {
    const opts = options || {};
    const host = opts.host || RCON_HOST;
    const port = opts.port || record.rconPort || 25575;
    const password = opts.password !== undefined ? opts.password : (record.rconPassword || "");
    const timeoutMs = opts.timeoutMs || RCON_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
        let settled = false;
        let buffer = Buffer.alloc(0);
        let authenticated = false;
        let finishTimer = null;
        const chunks = [];

        const socket = net.connect({ host, port });
        socket.setNoDelay(true);

        const overall = setTimeout(() => {
            finish(new Error("RCON 超时（" + timeoutMs + "ms），请确认服务器已启动且 enable-rcon=true"));
        }, timeoutMs);

        function finish(error, value) {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(overall);
            if (finishTimer) {
                clearTimeout(finishTimer);
            }
            try { socket.destroy(); } catch (ignored) { /* 关闭失败无需处理 */ }
            if (error) {
                reject(error);
            } else {
                resolve(value);
            }
        }

        socket.on("connect", () => {
            socket.write(buildPacket(1, 3, password));
        });

        socket.on("error", (error) => {
            finish(new Error("无法连接 RCON " + host + ":" + port + "（" + error.message +
                             "），服务器可能没有运行"));
        });

        socket.on("close", () => {
            if (chunks.length) {
                finish(null, chunks.join(""));
            } else {
                finish(new Error("RCON 连接已关闭，未收到响应"));
            }
        });

        socket.on("data", (data) => {
            buffer = Buffer.concat([buffer, data]);
            for (;;) {
                if (buffer.length < 4) {
                    return;
                }
                const length = buffer.readInt32LE(0);
                if (length < 10 || length > 1024 * 1024) {
                    finish(new Error("RCON 报文长度异常：" + length));
                    return;
                }
                if (buffer.length < 4 + length) {
                    return;
                }
                const payload = buffer.subarray(4, 4 + length);
                buffer = buffer.subarray(4 + length);
                const id = payload.readInt32LE(0);
                const type = payload.readInt32LE(4);
                const body = payload.subarray(8, payload.length - 2).toString("utf8");

                if (!authenticated) {
                    if (id === -1) {
                        finish(new Error("RCON 密码错误"));
                        return;
                    }
                    authenticated = true;
                    socket.write(buildPacket(2, 2, command));
                    continue;
                }

                // 指令响应是 type=0；部分实现会先补一个空的 type=2 报文，忽略之。
                if (type === 0 || (type === 2 && body.length > 0)) {
                    if (body.length) {
                        chunks.push(body);
                    }
                    if (finishTimer) {
                        clearTimeout(finishTimer);
                    }
                    // 长响应会被拆成多个报文，等一小段空闲再收尾。
                    finishTimer = setTimeout(() => finish(null, chunks.join("")), 120);
                }
            }
        });
    });
}

/// RCON 是否能连上（用于判断服务器是否真的在跑，而不是只看 servers.json 的 status）。
async function probe(record, options) {
    const opts = Object.assign({ timeoutMs: 2500 }, options || {});
    try {
        const response = await rconExec(record, "list", opts);
        return { ok: true, response: response };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

/// `list` 的响应形如：There are 2 of a max of 20 players online: Steve, Alex
function parseListResponse(text) {
    const flat = String(text || "").trim();
    const match = /There are (\d+) of a max(?: of)? (\d+) players online/i.exec(flat);
    let names = [];
    const colon = flat.indexOf(":");
    if (colon >= 0) {
        const rest = flat.slice(colon + 1).trim();
        if (rest.length) {
            names = rest.split(",").map((item) => item.trim()).filter(Boolean);
        }
    }
    return {
        names: names,
        count: match ? parseInt(match[1], 10) : names.length,
        max: match ? parseInt(match[2], 10) : null
    };
}

// ------------------------------------------------------------- 玩家操作 ----

/// 每个操作的元数据：界面按钮与文档都从这里生成。
const ACTIONS = {
    kick: { label: "踢出", glyph: "⇱", danger: false, needsPlayer: true, needsText: true },
    ban: { label: "封禁", glyph: "⛔", danger: true, needsPlayer: true, needsText: true },
    unban: { label: "解封", glyph: "✔", danger: false, needsPlayer: true },
    op: { label: "设为 OP", glyph: "★", danger: false, needsPlayer: true },
    deop: { label: "取消 OP", glyph: "☆", danger: false, needsPlayer: true },
    whitelistAdd: { label: "加入白名单", glyph: "＋", danger: false, needsPlayer: true },
    whitelistRemove: { label: "移出白名单", glyph: "－", danger: false, needsPlayer: true },
    title: { label: "发送标题", glyph: "❖", danger: false, needsPlayer: true, needsText: true },
    tell: { label: "私信", glyph: "✉", danger: false, needsPlayer: true, needsText: true },
    say: { label: "全服广播", glyph: "☎", danger: false, needsText: true },
    gamemode: { label: "切换游戏模式", glyph: "◈", danger: false, needsPlayer: true, needsText: true },
    kill: { label: "击杀", glyph: "☠", danger: true, needsPlayer: true },
    whitelistOn: { label: "开启白名单", glyph: "▣", danger: false },
    whitelistOff: { label: "关闭白名单", glyph: "▢", danger: false },
    whitelistReload: { label: "重载白名单", glyph: "⟳", danger: false }
};

const GAMEMODES = ["survival", "creative", "adventure", "spectator"];

function textComponent(text, color) {
    return JSON.stringify({ text: String(text), color: color });
}

/// 名单文件里加一条（服务器停止时的退化路径）。
function upsertListEntry(list, name, extra) {
    const result = list.slice();
    const index = result.findIndex((entry) => nameOf(entry).toLowerCase() === name.toLowerCase());
    if (index >= 0) {
        result[index] = Object.assign({}, result[index], extra);
    } else {
        result.push(Object.assign({ name: name }, extra));
    }
    return result;
}

function removeListEntry(list, name) {
    return list.filter((entry) => nameOf(entry).toLowerCase() !== name.toLowerCase());
}

function nowIso() {
    return new Date().toISOString();
}

/**
 * 执行一个玩家操作。
 *
 * @param {string} root        管理器数据根目录
 * @param {object} record      服务器记录（servers.json 里的一项）
 * @param {string} action      ACTIONS 里的键
 * @param {string} player      玩家名（不需要玩家名的操作可留空）
 * @param {string} value       文本参数：标题内容 / 理由 / 私信 / 游戏模式
 * @param {string} value2      第二文本参数：标题时的副标题
 * @param {object} options     可选：{ dataDir } 用于读取 texts.json 里的默认文案
 * @returns {Promise<{ok:boolean, action:string, player:string, message:string,
 *                    response:string, via:string, warnings:string[]}>}
 */
async function performAction(root, record, action, player, value, value2, options) {
    const opts = options || {};
    const meta = ACTIONS[action];
    const warnings = [];
    if (!meta) {
        return { ok: false, action: action, player: player, message: "未知操作：" + action, response: "", via: "", warnings: warnings };
    }
    if (!record) {
        return { ok: false, action: action, player: player, message: "没有可用的服务器", response: "", via: "", warnings: warnings };
    }

    const name = String(player || "").trim();
    // RCON sends one command line per packet. Strip line breaks and cap the
    // length so a crafted reason / title can never append a second command.
    const cleanText = (input) => String(input === undefined || input === null ? "" : input)
        .replace(/[\r\n\u0000]+/g, " ")
        .slice(0, 256);
    let text = cleanText(value);
    let sub = cleanText(value2);
    // 页面按钮不带文本参数时，用 texts.json 里的默认文案（标题 / 理由 / 私信）。
    const texts = loadTexts(root, opts.dataDir).texts;
    if (!text) {
        if (action === "kick") {
            text = texts.kickReason;
        } else if (action === "ban") {
            text = texts.banReason;
        } else if (action === "title") {
            text = texts.title;
        } else if (action === "tell") {
            text = texts.tell;
        }
    }
    if (!sub && action === "title") {
        sub = texts.subtitle;
    }
    if (meta.needsPlayer && !name && action !== "say") {
        return { ok: false, action: action, player: name, message: "缺少玩家名", response: "", via: "", warnings: warnings };
    }
    // Only vanilla-style Java names may reach RCON or the list files; anything
    // else (spaces, quotes, control characters) is rejected instead of being
    // concatenated into a server command.
    if (name && !/^[A-Za-z0-9_]{1,16}$/.test(name)) {
        return { ok: false, action: action, player: name,
                 message: "玩家名不合法（只允许字母、数字、下划线，1-16 位）",
                 response: "", via: "", warnings: warnings };
    }

    let online = null;
    try {
        online = await probe(record);
    } catch (error) {
        online = { ok: false, error: String(error) };
    }
    const running = online.ok;

    async function rcon(command) {
        const response = await rconExec(record, command);
        return response;
    }

    try {
        if (running) {
            switch (action) {
            case "kick": {
                const response = await rcon("kick " + name + (text ? " " + text : ""));
                return done(true, "已踢出 " + name, response, "rcon", warnings);
            }
            case "ban": {
                const response = await rcon("ban " + name + (text ? " " + text : ""));
                return done(true, "已封禁 " + name, response, "rcon", warnings);
            }
            case "unban": {
                const response = await rcon("pardon " + name);
                return done(true, "已解除封禁 " + name, response, "rcon", warnings);
            }
            case "op": {
                const response = await rcon("op " + name);
                return done(true, "已将 " + name + " 设为 OP", response, "rcon", warnings);
            }
            case "deop": {
                const response = await rcon("deop " + name);
                return done(true, "已取消 " + name + " 的 OP", response, "rcon", warnings);
            }
            case "whitelistAdd": {
                const response = await rcon("whitelist add " + name);
                return done(true, "已将 " + name + " 加入白名单", response, "rcon", warnings);
            }
            case "whitelistRemove": {
                const response = await rcon("whitelist remove " + name);
                return done(true, "已将 " + name + " 移出白名单", response, "rcon", warnings);
            }
            case "whitelistOn": {
                const response = await rcon("whitelist on");
                return done(true, "已开启白名单", response, "rcon", warnings);
            }
            case "whitelistOff": {
                const response = await rcon("whitelist off");
                return done(true, "已关闭白名单", response, "rcon", warnings);
            }
            case "whitelistReload": {
                const response = await rcon("whitelist reload");
                return done(true, "已重载白名单文件", response, "rcon", warnings);
            }
            case "title": {
                const body = text || "欢迎回来";
                await rcon("title " + name + " times 10 70 20");
                if (sub) {
                    await rcon("title " + name + " subtitle " + textComponent(sub, "gray"));
                }
                const response = await rcon("title " + name + " title " + textComponent(body, "gold"));
                return done(true, "已向 " + name + " 发送标题", response, "rcon", warnings);
            }
            case "tell": {
                const response = await rcon("tell " + name + " " + (text || "请注意服务器规则"));
                return done(true, "已私信 " + name, response, "rcon", warnings);
            }
            case "say": {
                const response = await rcon("say " + (text || ""));
                return done(true, "已全服广播", response, "rcon", warnings);
            }
            case "gamemode": {
                const mode = GAMEMODES.indexOf(text) >= 0 ? text : "survival";
                const response = await rcon("gamemode " + mode + " " + name);
                return done(true, "已将 " + name + " 切换为 " + mode, response, "rcon", warnings);
            }
            case "kill": {
                const response = await rcon("kill " + name);
                return done(true, "已击杀 " + name, response, "rcon", warnings);
            }
            default:
                break;
            }
        }

        // 服务器没在运行 / RCON 不可用：能改文件的就改文件，其余给明确报错。
        warnings.push("服务器未运行或 RCON 不可用（" + (online.error || "未知原因") +
                      "），已直接修改服务器名单文件，重启后生效");
        switch (action) {
        case "whitelistAdd": {
            const resolved = await resolveUuid(root, record, name, {});
            noteUuid(warnings, resolved);
            const list = upsertListEntry(readList(root, record, "whitelist.json"), name, { uuid: resolved.uuid });
            writeList(root, record, "whitelist.json", list);
            return done(true, "已将 " + name + " 写入 whitelist.json（离线写入）", "", "file", warnings);
        }
        case "whitelistRemove": {
            const list = removeListEntry(readList(root, record, "whitelist.json"), name);
            writeList(root, record, "whitelist.json", list);
            return done(true, "已从 whitelist.json 移除 " + name, "", "file", warnings);
        }
        case "whitelistOn":
        case "whitelistOff": {
            writeProperty(root, record, "white-list", action === "whitelistOn" ? "true" : "false");
            warnings.push("已修改 server.properties；需要重启服务器（或使用 /whitelist reload）后生效");
            return done(true, "已写入 server.properties 的 white-list 设置", "", "file", warnings);
        }
        case "whitelistReload": {
            warnings.push("重载白名单需要服务器处于运行状态");
            return done(false, "服务器未运行，无法重载白名单", "", "file", warnings);
        }
        case "op": {
            const resolved = await resolveUuid(root, record, name, {});
            noteUuid(warnings, resolved);
            const list = upsertListEntry(readList(root, record, "ops.json"), name,
                                         { uuid: resolved.uuid, level: 4, bypassesPlayerLimit: false });
            writeList(root, record, "ops.json", list);
            return done(true, "已将 " + name + " 写入 ops.json（离线写入）", "", "file", warnings);
        }
        case "deop": {
            const list = removeListEntry(readList(root, record, "ops.json"), name);
            writeList(root, record, "ops.json", list);
            return done(true, "已从 ops.json 移除 " + name, "", "file", warnings);
        }
        case "ban": {
            const resolved = await resolveUuid(root, record, name, {});
            noteUuid(warnings, resolved);
            const list = upsertListEntry(readList(root, record, "banned-players.json"), name, {
                uuid: resolved.uuid,
                created: nowIso().replace("T", " ").slice(0, 19) + " +0000",
                source: "McServerManager",
                expires: "forever",
                reason: text || "Banned by an operator."
            });
            writeList(root, record, "banned-players.json", list);
            return done(true, "已将 " + name + " 写入 banned-players.json（离线写入）", "", "file", warnings);
        }
        case "unban": {
            const list = removeListEntry(readList(root, record, "banned-players.json"), name);
            writeList(root, record, "banned-players.json", list);
            return done(true, "已从 banned-players.json 移除 " + name, "", "file", warnings);
        }
        default:
            return done(false, ACTIONS[action].label + " 需要服务器处于运行状态（RCON 不可用）",
                        "", "file", warnings);
        }
    } catch (error) {
        return done(false, error.message, "", running ? "rcon" : "file", warnings);
    }

    function done(ok, message, response, via, list) {
        return {
            ok: ok,
            action: action,
            player: name,
            message: message,
            response: response || "",
            via: via,
            warnings: list || []
        };
    }

    function noteUuid(list, resolved) {
        if (resolved.source === "offline-guess") {
            list.push("在线模式（online-mode=true）下未能从 Mojang 查到 " + name +
                      " 的 UUID，已按离线 UUID 写入；若加入后无法生效，请在服务器运行时重做一次");
        } else if (resolved.source === "mojang") {
            list.push("已通过 Mojang 档案接口解析 " + name + " 的正版 UUID");
        }
    }
}

// ------------------------------------------------------------ 状态快照 ----

/// 原生插件页面使用的整页快照。
async function buildDashboard(root, want, options) {
    const opts = options || {};
    const servers = loadServers(root);
    const summaries = servers.map(summarize);
    const warnings = [];
    const record = findServer(servers, want);

    if (!record) {
        return {
            root: root,
            servers: summaries,
            server: null,
            online: { names: [], count: 0, max: null },
            rcon: { ok: false, error: "没有服务器" },
            whitelist: [],
            ops: [],
            banned: [],
            known: [],
            properties: {},
            warnings: ["还没有可管理的服务器，请先在「服务器」页创建一台"]
        };
    }

    let online = { names: [], count: 0, max: null };
    let rcon = { ok: false, error: "" };
    try {
        online = parseListResponse(await rconExec(record, "list", opts));
        rcon = { ok: true, error: "" };
    } catch (error) {
        rcon = { ok: false, error: error.message };
    }

    const whitelist = readList(root, record, "whitelist.json")
        .map((entry) => ({ name: nameOf(entry), uuid: uuidOf(entry) }));
    const ops = readList(root, record, "ops.json")
        .map((entry) => ({ name: nameOf(entry), uuid: uuidOf(entry), level: entry.level || 4 }));
    const banned = readList(root, record, "banned-players.json")
        .map((entry) => ({ name: nameOf(entry), uuid: uuidOf(entry), reason: entry.reason || "",
                           expires: entry.expires || "" }));
    const known = readList(root, record, "usercache.json")
        .map((entry) => ({ name: nameOf(entry), uuid: uuidOf(entry) }));

    const properties = readProperties(root, record);
    const whitelistEnabled = String(properties["white-list"] || "false").toLowerCase() === "true";
    const texts = loadTexts(root, opts.dataDir);

    if (!rcon.ok) {
        warnings.push("无法连接 RCON：" + rcon.error);
        warnings.push("名单类操作仍可用（直接写名单文件），但踢出 / 标题 / 私信等需要服务器处于运行状态");
    }

    return {
        root: root,
        servers: summaries,
        server: summarize(record),
        online: online,
        rcon: rcon,
        whitelist: whitelist,
        ops: ops,
        banned: banned,
        known: known,
        properties: {
            "white-list": whitelistEnabled,
            "online-mode": String(properties["online-mode"] || "true").toLowerCase() !== "false",
            "max-players": properties["max-players"] || ""
        },
        texts: texts.texts,
        textsPath: texts.path,
        textsSource: texts.source,
        actions: Object.keys(ACTIONS).map((key) => Object.assign({ id: key }, ACTIONS[key])),
        gamemodes: GAMEMODES,
        warnings: warnings
    };
}

module.exports = {
    ACTIONS,
    DEFAULT_TEXTS,
    GAMEMODES,
    buildDashboard,
    defaultRoot,
    findServer,
    loadServers,
    loadTexts,
    offlineUuid,
    parseListResponse,
    performAction,
    probe,
    readJson,
    readList,
    readProperties,
    readText,
    resolveRoot,
    rconExec,
    saveTexts,
    serverDir,
    serverFile,
    summarize,
    writeJson,
    writeList,
    writeProperty
};
