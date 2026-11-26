/*
 * 容器搬运工 —— 后端部分（JSON-Line 协议）。
 *
 * 管理器每次调用都会拉起一个 node 进程，从 stdin 读一行 JSON 请求、往 stdout 写一行结果：
 *   { apiVersion, plugin, method, params, caller, pluginsDir, dataDir, requestedAt }
 *
 * 支持的方法（参数直接编码在方法名里，避免命令行里的引号/空格被吃掉）：
 *   export~<服务器id[,id]>~<0|1|2>[~<encodeURIComponent(目标文件或目录)>]
 *                               导出容器包；0=数据+配置，1=再带容器镜像，2=再带备份与日志
 *                               单选一个服务器时可指定 .tar 文件，多选时给目录
 *   import~<encodeURIComponent(文件路径)>   把容器包导入成一台新服务器
 *   scan                        列出导出目录里可导入的 .tar 容器包
 *   open-folder                 打开导出目录
 *   info                        自检信息
 *
 * 容器包（单个 .tar）内部结构：
 *   manifest.json   记录快照（服务器记录 + 镜像引用 + 导出时间）
 *   data.tar        服务器目录（world / plugins / 配置 / start.sh …）
 *   image.tar       可选，docker save 出来的容器镜像
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const readline = require("readline");

/** 从安装目录里的 plugin.json 读版本号，避免升级插件后后端还报旧版本。 */
function readOwnManifest() {
    const candidates = [process.env.MCSM_PLUGIN_DIR, path.resolve(__dirname, "..")];
    for (const dir of candidates) {
        if (!dir) continue;
        try {
            return JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
        } catch (err) {
            // 换下一个候选目录
        }
    }
    return {};
}

const MANIFEST = readOwnManifest();
const PLUGIN_ID = process.env.MCSM_PLUGIN_ID || MANIFEST.id || "com.mcsm.container-porter";
const BUNDLE_FORMAT = "mcsm-container-porter/1";
// 管理器以后会注入 MCSM_PLUGIN_VERSION；在那之前从 plugin.json 读。
const PLUGIN_VERSION = process.env.MCSM_PLUGIN_VERSION || MANIFEST.version || "0.0.0";
const TAR = process.platform === "win32" ? "tar.exe" : "tar";
const DOCKER_TIMEOUT = 30 * 60 * 1000;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 32 * 1024 * 1024 * 1024;

function reply(object) {
    process.stdout.write(JSON.stringify(object) + "\n");
}

function progress(line) {
    process.stdout.write(JSON.stringify({ type: "log", line: String(line) }) + "\n");
}

function ok(data) {
    return { ok: true, data: data || {} };
}

function fail(code, message, detail) {
    return { ok: false, error: { code: code, message: message, detail: detail || "" } };
}

function nowIso() {
    return new Date().toISOString();
}

function encodeToken(value) {
    return encodeURIComponent(String(value === undefined || value === null ? "" : value))
        .replace(/~/g, "%7E");
}

function decodeToken(value) {
    try {
        return decodeURIComponent(String(value === undefined || value === null ? "" : value));
    } catch (error) {
        return null;
    }
}

function sourceIdentity(request) {
    const dataDir = request && request.dataDir;
    if (!dataDir) return "";
    const file = path.join(dataDir, "source-id");
    try {
        const existing = fs.readFileSync(file, "utf8").trim();
        if (/^[a-f0-9]{32,64}$/i.test(existing)) return existing;
    } catch (error) {
        // 首次导出时生成
    }
    const created = crypto.randomBytes(16).toString("hex");
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(file, created + "\n", "utf8");
    } catch (error) {
        // 无法持久化时仍然在本次进程里使用一个临时标识
    }
    return created;
}

const cleanedRoots = new Set();
function cleanupStaleTemps(request) {
    const root = dataRootOf(request);
    if (!root || cleanedRoots.has(root)) return;
    cleanedRoots.add(root);
    const dir = path.join(root, "tmp");
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        return;
    }
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const entry of entries) {
        if (!entry.isDirectory() || !/^porter-/.test(entry.name)) continue;
        const full = path.join(dir, entry.name);
        try {
            if (fs.statSync(full).mtimeMs < cutoff) cleanup(full);
        } catch (error) {
            // 并发进程可能已经清理
        }
    }
}

function stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-"
        + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/// 小写、只保留 [a-z0-9_-]，用作目录名 / 镜像名的一部分。
function slugify(text) {
    const slug = String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || "server";
}

/// 保留中文等可读字符，只替换掉 Windows 文件名里不允许的符号。
function safeFileName(text) {
    const name = String(text || "")
        .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^[. ]+|[. ]+$/g, "")
        .slice(0, 60);
    return name || "server";
}

function run(cmd, args, options) {
    const opts = Object.assign({ encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, options || {});
    const result = spawnSync(cmd, args, opts);
    return {
        ok: !result.error && result.status === 0,
        status: result.status,
        out: (result.stdout || "").trim(),
        err: (result.stderr || "").trim(),
        error: result.error ? String(result.error.message) : ""
    };
}

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(".." + path.sep)
        && relative !== ".." && !path.isAbsolute(relative));
}

function isSafeMemberName(name) {
    const normalized = String(name || "").trim().replace(/\\/g, "/");
    if (!normalized || normalized === ".") return true;
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
    return !normalized.split("/").some((part) => part === "..");
}

function verboseEntrySize(line) {
    const tokens = line.trim().split(/\s+/);
    for (let i = 2; i < tokens.length; ++i) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(tokens[i])
            || /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i.test(tokens[i])
            || /^\d{1,2}月$/.test(tokens[i])) {
            const size = Number(tokens[i - 1]);
            if (Number.isFinite(size) && size >= 0) return size;
        }
    }
    const fallbackIndex = tokens[1] && tokens[1].includes("/") ? 2 : 3;
    const fallback = Number(tokens[fallbackIndex]);
    if (Number.isFinite(fallback) && fallback >= 0) return fallback;
    return null;
}

/// Reject traversal and link members before tar is allowed to write anything.
/// The verbose listing also gives us an uncompressed-size estimate for quota.
function auditTar(file, label, maxBytes) {
    let stat;
    try {
        stat = fs.statSync(file);
    } catch (error) {
        return fail("FILE_NOT_FOUND", "找不到" + label, String(error.message || error));
    }
    if (stat.size > MAX_BUNDLE_BYTES) {
        return fail("IMPORT_QUOTA", label + "超过导入大小上限",
            Math.round(stat.size) + " > " + MAX_BUNDLE_BYTES);
    }

    const names = run(TAR, ["-tf", file], { timeout: DOCKER_TIMEOUT });
    if (!names.ok) return fail("BUNDLE_INVALID", "无法读取" + label + "成员列表", names.err || names.error);
    for (const name of names.out.split(/\r?\n/)) {
        if (!isSafeMemberName(name)) {
            return fail("BUNDLE_UNSAFE", label + "包含越界路径", name);
        }
    }

    const verbose = run(TAR, ["-tvf", file], { timeout: DOCKER_TIMEOUT });
    if (!verbose.ok) return fail("BUNDLE_INVALID", "无法审计" + label + "成员类型", verbose.err || verbose.error);
    let total = 0;
    for (const line of verbose.out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("l") || trimmed.startsWith("h") || /\blink to\b/i.test(trimmed)) {
            return fail("BUNDLE_UNSAFE", label + "包含符号链接或硬链接", trimmed);
        }
        if (trimmed.startsWith("-")) {
            const size = verboseEntrySize(trimmed);
            if (size === null) {
                return fail("BUNDLE_INVALID", "无法估算" + label + "解压大小", trimmed);
            }
            total += size;
            if (total > maxBytes) {
                return fail("IMPORT_QUOTA", label + "预估解压总量超过上限",
                    total + " > " + maxBytes);
            }
        }
    }
    return ok({ estimatedBytes: total });
}

function assertRealPathsInside(root) {
    const canonicalRoot = fs.realpathSync(root);
    const pending = [canonicalRoot];
    while (pending.length) {
        const dir = pending.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const info = fs.lstatSync(full);
            if (info.isSymbolicLink()) {
                throw new Error("解压结果包含符号链接：" + full);
            }
            const real = fs.realpathSync(full);
            if (!isInside(canonicalRoot, real)) {
                throw new Error("解压结果越出目标目录：" + full);
            }
            if (info.isDirectory()) pending.push(real);
        }
    }
}

function docker(args, options) {
    return run("docker", args, options || {});
}

function cleanup(dir) {
    if (!dir) return;
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
        // 清理失败不影响结果
    }
}

/// `<数据根>/plugins` -> `<数据根>`
function dataRootOf(request) {
    if (request && request.pluginsDir) return path.dirname(request.pluginsDir);
    const dataDir = (request && request.dataDir) || process.env.MCSM_PLUGIN_DATA || "";
    if (!dataDir) return "";
    // <root>/plugins/.data/<plugin id>
    return path.dirname(path.dirname(path.dirname(dataDir)));
}

function storeFile(root) {
    return path.join(root, "servers.json");
}

function readStore(root) {
    if (!root) return { ok: false, error: "无法定位管理器数据目录" };
    // 全新安装的管理器还没有 servers.json，这属于「空注册表」而不是损坏。
    if (!fs.existsSync(storeFile(root))) {
        return { ok: true, data: { version: 1, servers: [] } };
    }
    try {
        const raw = fs.readFileSync(storeFile(root), "utf8");
        const parsed = JSON.parse(raw);
        const data = Array.isArray(parsed) ? { servers: parsed } : parsed;
        if (!Array.isArray(data.servers)) data.servers = [];
        return { ok: true, data: data };
    } catch (error) {
        return { ok: false, error: String(error.message || error) };
    }
}

/// servers.json has one writer: the manager CLI. The plugin hands it a private
/// temporary record so concurrent manager writes and imports serialize through
/// ServerStore's transaction lock.
function registerRecord(root, record, work) {
    const backend = process.env.MCSM_BACKEND;
    if (!backend) {
        return { ok: false, error: "管理器没有提供受控后端路径（MCSM_BACKEND）" };
    }
    const file = path.join(work, "record-" + crypto.randomBytes(8).toString("hex") + ".json");
    fs.writeFileSync(file, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    try {
        let output = "";
        try {
            output = execFileSync(backend, ["--home", root, "server", "register", "--file", file], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 30000,
                maxBuffer: 2 * 1024 * 1024
            });
        } catch (error) {
            output = String((error && error.stdout) || "");
            if (!output.trim()) {
                return { ok: false, error: String((error && error.message) || error) };
            }
        }
        const lines = output.trim().split(/\r?\n/).reverse();
        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                if (parsed && Object.prototype.hasOwnProperty.call(parsed, "ok")) return parsed;
            } catch (error) {
                // keep looking for the final JSON envelope
            }
        }
        return { ok: false, error: "mcsm-cli 没有返回 JSON 结果" };
    } finally {
        try {
            fs.unlinkSync(file);
        } catch (error) {
            // work directory cleanup also handles this
        }
    }
}

function sanitizeRecord(record) {
    const copy = {};
    const fields = ["name", "type", "mcVersion", "build", "jarName", "image", "runtime",
        "memory", "memoryLimit", "port", "rconPort", "motd", "levelName",
        "eulaAccepted", "autoRestart", "autoStart", "manualInstall"];
    for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(record || {}, field)) copy[field] = record[field];
    }
    // 容器包默认不带凭据和本机路径。
    delete copy.rconPassword;
    delete copy.jdkHome;
    delete copy.extraJavaOptions;
    delete copy.dir;
    delete copy.status;
    delete copy.lastError;
    delete copy.lastStartAt;
    delete copy.lastBackupAt;
    return copy;
}

function safeImportedServer(base, id, name, ports, rconPassword) {
    const source = base && typeof base === "object" ? base : {};
    const text = (value, max) => String(value === undefined || value === null ? "" : value)
        .replace(/[\r\n\u0000]+/g, " ").trim().slice(0, max);
    const type = ["vanilla", "paper", "purpur", "fabric"].indexOf(String(source.type)) >= 0
        ? String(source.type) : "paper";
    const runtime = source.runtime === "host" ? "host" : "docker";
    const memory = /^[0-9]{1,5}[MG]$/i.test(String(source.memory || ""))
        ? String(source.memory).toUpperCase() : "4G";
    const memoryLimit = /^[0-9]{1,5}[mMgG]$/.test(String(source.memoryLimit || ""))
        ? String(source.memoryLimit) : "";
    const image = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(String(source.image || ""))
        ? String(source.image) : "eclipse-temurin:17-jre";
    return {
        id: id,
        name: name,
        type: type,
        mcVersion: text(source.mcVersion, 64),
        build: text(source.build, 64),
        jarName: text(source.jarName || "server.jar", 128),
        image: image,
        runtime: runtime,
        memory: memory,
        memoryLimit: memoryLimit,
        port: ports.port,
        rconPort: ports.rconPort,
        rconPassword: rconPassword,
        motd: text(source.motd, 256),
        levelName: text(source.levelName || "world", 64) || "world",
        eulaAccepted: false,
        autoRestart: source.autoRestart === true,
        autoStart: false,
        manualInstall: false
    };
}

function redactServerProperties(content) {
    const lines = String(content || "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*rcon\.password\s*=/.test(lines[i])) {
            lines[i] = "rcon.password=__MCSM_PORTER_REDACTED__";
        }
    }
    return lines.join("\n");
}

function redactPropertiesTree(dir) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            redactPropertiesTree(full);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".properties")) {
            try {
                fs.writeFileSync(full, redactServerProperties(fs.readFileSync(full, "utf8")), "utf8");
            } catch (error) {
                // 单文件失败会在后续打包时报错
            }
        }
    }
}

function setProperty(content, key, value) {
    const lines = content.split("\n");
    let found = false;
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^\s*([^=:\s][^=:]*?)\s*[=:]/);
        if (match && match[1].trim() === key) {
            lines[i] = key + "=" + value;
            found = true;
        }
    }
    if (!found) lines.push(key + "=" + value);
    return lines.join("\n");
}

/// 端口保留原来的，被占用时顺序找一个空闲的。
function allocatePorts(servers, wantedPort, wantedRcon) {
    const used = new Set();
    for (const server of servers) {
        if (server && server.port) used.add(Number(server.port));
        if (server && server.rconPort) used.add(Number(server.rconPort));
    }
    const free = (preferred, start) => {
        let port = Number(preferred) > 0 ? Number(preferred) : start;
        if (port <= 0 || port > 65535) port = start;
        for (let i = 0; i < 500; i++) {
            const candidate = port + i;
            if (candidate > 65535) break;
            if (!used.has(candidate)) return candidate;
        }
        return 0;
    };
    const port = free(wantedPort, 25565);
    used.add(port);
    const rconPort = free(wantedRcon, port + 10);
    return { port: port, rconPort: rconPort };
}

function uniqueName(servers, wanted) {
    const names = new Set(servers.map((server) => String((server && server.name) || "")));
    if (!names.has(wanted)) return wanted;
    const base = wanted + "（导入）";
    if (!names.has(base)) return base;
    for (let i = 2; i < 500; i++) {
        const candidate = base + " " + i;
        if (!names.has(candidate)) return candidate;
    }
    return base + " " + Date.now();
}

function uniqueId(servers, wanted) {
    const ids = new Set(servers.map((server) => String((server && server.id) || "")));
    if (!ids.has(wanted)) return wanted;
    for (let i = 2; i < 500; i++) {
        const candidate = wanted + "-" + i;
        if (!ids.has(candidate)) return candidate;
    }
    return wanted + "-" + Date.now();
}

// ------------------------------------------------------------------ 导出 ---

function exportContainer(request, serverId, mode, target, asFile) {
    const root = dataRootOf(request);
    if (!root) return fail("NO_DATA_ROOT", "无法定位管理器数据目录");

    const store = readStore(root);
    if (!store.ok) return fail("STORE_CORRUPT", "servers.json 无法读取", store.error);
    const record = store.data.servers.find((server) => server && server.id === serverId);
    if (!record) return fail("NOT_FOUND", "服务器 " + serverId + " 不存在");

    const serverDir = record.dir || path.join(root, "servers", serverId);
    if (!fs.existsSync(serverDir)) return fail("SERVER_DIR_MISSING", "服务器目录不存在", serverDir);

    const exportsDir = path.join(root, "exports");
    fs.mkdirSync(exportsDir, { recursive: true });
    fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
    const work = path.join(root, "tmp", "porter-" + stamp() + "-" + process.pid);
    fs.mkdirSync(work, { recursive: true });
    const sourceId = sourceIdentity(request);

    const withImage = mode === 1 || mode === 2;
    const withBackups = mode === 2;
    let imageRef = record.image || "";
    let packagedImage = false;

    const container = "mcsm-" + serverId;
    const inspect = docker(["inspect", "-f", "{{.State.Status}}", container]);
    const containerExists = inspect.ok && inspect.out.length > 0;

    if (withImage && containerExists) {
        const tag = "mcsm-porter/" + slugify(serverId) + ":" + stamp();
        progress("提交容器 " + container + " 为镜像 " + tag + " …");
        const commit = docker(["commit", container, tag]);
        if (!commit.ok) {
            cleanup(work);
            return fail("COMMIT_FAILED", "docker commit 失败", commit.err || commit.error);
        }
        progress("保存镜像（体积较大，请稍候）…");
        const saved = docker(["save", "-o", path.join(work, "image.tar"), tag], { timeout: DOCKER_TIMEOUT });
        if (!saved.ok) {
            cleanup(work);
            return fail("SAVE_FAILED", "docker save 失败", saved.err || saved.error);
        }
        imageRef = tag;
        packagedImage = true;
        docker(["rmi", tag]);   // 临时镜像，导出后即可删除
    } else if (withImage) {
        progress("容器不存在（服务器从未启动或已被删除），跳过镜像导出，只打包数据");
    }

    progress("打包服务器目录 …");
    const dataTar = path.join(work, "data.tar");
    const tarArgs = ["-cf", dataTar, "-C", serverDir];
    const excluded = [];
    if (!withBackups) {
        tarArgs.push("--exclude", "backups", "--exclude", "logs");
        excluded.push("backups", "logs");
    }
    const originalProperties = path.join(serverDir, "server.properties");
    const sanitizedProperties = path.join(work, "server.properties");
    const originalConfigBackups = path.join(serverDir, "config-backups");
    const sanitizedConfigBackups = path.join(work, "config-backups");
    let propertiesRedacted = false;
    if (fs.existsSync(originalProperties)) {
        fs.writeFileSync(sanitizedProperties,
            redactServerProperties(fs.readFileSync(originalProperties, "utf8")), "utf8");
        tarArgs.push("--exclude", "./server.properties");
        propertiesRedacted = true;
    }
    let backupsRedacted = false;
    if (fs.existsSync(originalConfigBackups)) {
        fs.cpSync(originalConfigBackups, sanitizedConfigBackups, { recursive: true });
        redactPropertiesTree(sanitizedConfigBackups);
        tarArgs.push("--exclude", "./config-backups");
        backupsRedacted = true;
    }
    tarArgs.push(".");
    const packed = run(TAR, tarArgs, { timeout: DOCKER_TIMEOUT });
    if (!packed.ok) {
        cleanup(work);
        return fail("DATA_PACK_FAILED", "打包服务器目录失败", packed.err || packed.error);
    }
    if (propertiesRedacted) {
        const appended = run(TAR, ["-rf", dataTar, "-C", work, "server.properties"],
            { timeout: DOCKER_TIMEOUT });
        if (!appended.ok) {
            cleanup(work);
            return fail("DATA_PACK_FAILED", "写入脱敏配置失败", appended.err || appended.error);
        }
    }
    if (backupsRedacted) {
        const appended = run(TAR, ["-rf", dataTar, "-C", work, "config-backups"],
            { timeout: DOCKER_TIMEOUT });
        if (!appended.ok) {
            cleanup(work);
            return fail("DATA_PACK_FAILED", "写入脱敏配置快照失败", appended.err || appended.error);
        }
    }

    const manifest = {
        format: BUNDLE_FORMAT,
        createdAt: nowIso(),
        manager: (request && request.managerVersion) || "",
        plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
        source: {
            manager: "McServerManager",
            instanceId: sourceId,
            hostname: os.hostname(),
            exportedAt: nowIso()
        },
        image: { ref: imageRef, packaged: packagedImage },
        credentials: { redacted: propertiesRedacted || backupsRedacted },
        data: { excluded: excluded, bytes: fs.statSync(dataTar).size },
        server: sanitizeRecord(record)
    };
    fs.writeFileSync(path.join(work, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    const bundleName = safeFileName(record.name || serverId) + "-" + stamp() + ".tar";
    let bundle = path.join(exportsDir, bundleName);
    if (target) {
        // One server -> the user picked a file to save; several servers -> the
        // user picked a folder and every bundle lands inside it.
        const dirTarget = !asFile || !/\.tar$/i.test(target);
        bundle = dirTarget ? path.join(target, bundleName) : target;
        try {
            fs.mkdirSync(path.dirname(bundle), { recursive: true });
        } catch (error) {
            cleanup(work);
            return fail("TARGET_INVALID", "无法创建导出目录", String(error.message || error));
        }
    }
    const parts = ["manifest.json", "data.tar"];
    if (packagedImage) parts.push("image.tar");
    progress("生成容器包 " + bundleName + " …");
    const bundleRun = run(TAR, ["-cf", bundle, "-C", work].concat(parts), { timeout: DOCKER_TIMEOUT });
    if (!bundleRun.ok) {
        cleanup(work);
        return fail("BUNDLE_FAILED", "生成容器包失败", bundleRun.err || bundleRun.error);
    }

    const size = fs.statSync(bundle).size;
    cleanup(work);
    return ok({
        file: bundle,
        name: bundleName,
        sizeBytes: size,
        image: { ref: imageRef, packaged: packagedImage },
        server: { id: record.id, name: record.name }
    });
}

// ------------------------------------------------------------------ 导入 ---

function importContainer(request, file, flags) {
    const allow = flags || {};
    const root = dataRootOf(request);
    if (!root) return fail("NO_DATA_ROOT", "无法定位管理器数据目录");
    if (!file || !fs.existsSync(file)) return fail("FILE_NOT_FOUND", "找不到容器包", String(file || ""));

    fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
    const work = path.join(root, "tmp", "porter-import-" + stamp() + "-" + process.pid);
    fs.mkdirSync(work, { recursive: true });

    const outerAudit = auditTar(file, "容器包", MAX_BUNDLE_BYTES);
    if (!outerAudit.ok) {
        cleanup(work);
        return outerAudit;
    }
    progress("解开容器包 …");
    const unpack = run(TAR, ["-xf", file, "-C", work], { timeout: DOCKER_TIMEOUT });
    if (!unpack.ok) {
        cleanup(work);
        return fail("BUNDLE_INVALID", "无法解开容器包", unpack.err || unpack.error);
    }
    try {
        assertRealPathsInside(work);
    } catch (error) {
        cleanup(work);
        return fail("BUNDLE_UNSAFE", "容器包解压结果越界", String(error.message || error));
    }

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(work, "manifest.json"), "utf8"));
    } catch (error) {
        cleanup(work);
        return fail("BUNDLE_INVALID", "容器包缺少 manifest.json", String(error.message || error));
    }
    if (!manifest || manifest.format !== BUNDLE_FORMAT) {
        cleanup(work);
        return fail("BUNDLE_FORMAT", "这不是「容器搬运工」导出的容器包");
    }
    const base = manifest.server || {};
    const localSource = sourceIdentity(request);
    const packageSource = manifest.source && typeof manifest.source.instanceId === "string"
        ? manifest.source.instanceId : "";
    const trustedSource = !!localSource && packageSource === localSource;

    let imageRef = (manifest.image && manifest.image.ref) || "";
    let packagedImage = false;
    const imageTar = path.join(work, "image.tar");
    if (fs.existsSync(imageTar)) {
        if (!trustedSource && !allow.allowUntrustedImage) {
            cleanup(work);
            return fail("IMPORT_CONFIRM_REQUIRED",
                "镜像不是由本机导出的，载入前需要明确确认。", "image");
        }
        progress("载入容器镜像 …");
        const loaded = docker(["load", "-i", imageTar], { timeout: DOCKER_TIMEOUT });
        if (!loaded.ok) {
            cleanup(work);
            return fail("IMAGE_LOAD_FAILED", "docker load 失败", loaded.err || loaded.error);
        }
        const match = (loaded.out + "\n" + loaded.err).match(/Loaded image:?\s*(\S+)/i);
        if (match) imageRef = match[1];
        packagedImage = true;
    }
    if (base.runtime === "host" && !allow.allowHost) {
        cleanup(work);
        return fail("IMPORT_CONFIRM_REQUIRED",
            "该包声明使用本机 JDK 运行，导入前需要管理员显式确认。", "host");
    }

    const store = readStore(root);
    if (!store.ok) {
        cleanup(work);
        return fail("STORE_CORRUPT", "servers.json 无法读取", store.error);
    }

    const servers = store.data.servers;
    const name = uniqueName(servers, String(base.name || "导入的服务器"));
    const id = uniqueId(servers, slugify(base.id || name));
    const ports = allocatePorts(servers, base.port, base.rconPort);
    if (!ports.port || !ports.rconPort) {
        cleanup(work);
        return fail("NO_FREE_PORT", "找不到可用的服务器端口");
    }

    const targetDir = path.join(root, "servers", id);
    if (fs.existsSync(targetDir)) {
        cleanup(work);
        return fail("TARGET_EXISTS", "目标目录已存在", targetDir);
    }
    fs.mkdirSync(targetDir, { recursive: true });

    progress("解压服务器数据到 " + targetDir + " …");
    const dataTar = path.join(work, "data.tar");
    if (!fs.existsSync(dataTar)) {
        cleanup(work);
        return fail("BUNDLE_INVALID", "容器包里没有 data.tar");
    }
    const dataAudit = auditTar(dataTar, "服务器数据包", MAX_EXTRACTED_BYTES);
    if (!dataAudit.ok) {
        cleanup(work);
        return dataAudit;
    }
    const extracted = run(TAR, ["-xf", dataTar, "-C", targetDir], { timeout: DOCKER_TIMEOUT });
    if (!extracted.ok) {
        cleanup(targetDir);
        cleanup(work);
        return fail("EXTRACT_FAILED", "解压服务器数据失败", extracted.err || extracted.error);
    }
    try {
        assertRealPathsInside(targetDir);
    } catch (error) {
        cleanup(targetDir);
        cleanup(work);
        return fail("BUNDLE_UNSAFE", "服务器数据解压结果越界", String(error.message || error));
    }

    const importedPassword = crypto.randomBytes(18).toString("base64")
        .replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
    // 导出包不携带原 RCON 密码；导入时始终生成新密码并写回配置。
    const propertiesFile = path.join(targetDir, "server.properties");
    let content = fs.existsSync(propertiesFile) ? fs.readFileSync(propertiesFile, "utf8") : "";
    content = setProperty(content, "server-port", String(ports.port));
    content = setProperty(content, "rcon.port", String(ports.rconPort));
    content = setProperty(content, "rcon.password", importedPassword);
    content = setProperty(content, "enable-rcon", "true");
    fs.writeFileSync(propertiesFile, content, "utf8");

    const record = safeImportedServer(base, id, name, ports, importedPassword);
    record.dir = targetDir;
    record.status = "stopped";
    record.createdAt = nowIso();
    if (record.runtime === "host") {
        record.jdkHome = path.join(targetDir, "jdk");
    } else {
        record.runtime = "docker";
        if (imageRef) record.image = imageRef;
    }

    const registered = registerRecord(root, record, work);
    if (!registered.ok) {
        cleanup(targetDir);
        cleanup(work);
        const info = (registered.error && registered.error.message) || registered.error;
        return fail("STORE_WRITE_FAILED", "通过管理器注册服务器失败", String(info || "未知错误"));
    }

    cleanup(work);
    return ok({
        id: id,
        name: name,
        port: ports.port,
        rconPort: ports.rconPort,
        image: record.image || "",
        dir: targetDir,
        imagePackaged: packagedImage,
        message: "已加入服务器列表"
    });
}

// ------------------------------------------------------------- 其他方法 ---

function tarOctal(buffer, offset, length) {
    const raw = buffer.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/, "").trim();
    return raw ? parseInt(raw, 8) : 0;
}

async function readTarManifest(file) {
    const handle = await fs.promises.open(file, "r");
    try {
        const header = Buffer.alloc(512);
        const { bytesRead } = await handle.read(header, 0, 512, 0);
        if (bytesRead !== 512) throw new Error("tar 头部不完整");
        const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "").replace(/^\.\//, "");
        if (name !== "manifest.json") throw new Error("容器包首项不是 manifest.json");
        const size = tarOctal(header, 124, 12);
        if (!Number.isFinite(size) || size < 2 || size > 1024 * 1024) {
            throw new Error("manifest.json 大小异常");
        }
        const data = Buffer.alloc(size);
        const read = await handle.read(data, 0, size, 512);
        if (read.bytesRead !== size) throw new Error("manifest.json 不完整");
        return JSON.parse(data.toString("utf8"));
    } finally {
        await handle.close();
    }
}

async function scanBundles(request) {
    const root = dataRootOf(request);
    if (!root) return fail("NO_DATA_ROOT", "无法定位管理器数据目录");
    const dir = path.join(root, "exports");
    await fs.promises.mkdir(dir, { recursive: true });

    let names = [];
    try {
        names = (await fs.promises.readdir(dir)).filter((name) => name.toLowerCase().endsWith(".tar"));
    } catch (error) {
        return fail("SCAN_FAILED", "无法读取导出目录", String(error.message || error));
    }
    names.sort();
    names = names.slice(-50).reverse();

    const items = [];
    for (const name of names) {
        const full = path.join(dir, name);
        let stat = null;
        try {
            stat = await fs.promises.stat(full);
        } catch (error) {
            continue;
        }
        let info = {};
        try {
            info = await readTarManifest(full);
        } catch (error) {
            info = {};
        }
        items.push({
            file: full,
            name: name,
            sizeBytes: stat.size,
            mtime: stat.mtime.toISOString(),
            serverName: (info.server && info.server.name) || "",
            format: info.format || "",
            hasImage: !!(info.image && info.image.packaged)
        });
    }
    return ok({ dir: dir, items: items });
}

function openFolder(request) {
    const root = dataRootOf(request);
    if (!root) return fail("NO_DATA_ROOT", "无法定位管理器数据目录");
    const dir = path.join(root, "exports");
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === "win32") {
        spawnSync("explorer.exe", [dir], { windowsHide: true, timeout: 15000 });
    } else if (process.platform === "darwin") {
        spawnSync("open", [dir], { timeout: 15000 });
    } else {
        spawnSync("xdg-open", [dir], { timeout: 15000 });
    }
    return ok({ dir: dir });
}

// ------------------------------------------------------------------ 入口 ---

function handle(request) {
    cleanupStaleTemps(request);
    const method = String((request && request.method) || "");

    if (method === "info" || method === "describe") {
        return ok({
            name: "容器搬运工",
            id: PLUGIN_ID,
            version: PLUGIN_VERSION,
            capabilities: ["export", "import", "scan", "open-folder"],
            dataRoot: dataRootOf(request)
        });
    }
    if (method === "plugin.install" || method === "plugin.enable") {
        return ok({ acknowledged: true });
    }
    if (method === "scan") {
        return scanBundles(request);
    }
    if (method === "open-folder") {
        return openFolder(request);
    }
    if (method.indexOf("export~") === 0) {
        const parts = method.split("~");
        // export~<id,id,...>~<0|1|2>~<encodeURIComponent(目标文件或目录)>
        const ids = String(parts[1] || "").split(",")
            .map((id) => decodeToken(id))
            .filter((id) => id !== null)
            .map((id) => id.trim())
            .filter((id) => id.length > 0);
        const mode = Number(parts[2] || 0);
        const target = parts.length > 3 ? decodeToken(parts.slice(3).join("~")) : "";
        if (target === null) return fail("INVALID_ARGUMENT", "导出目标路径编码无效");
        if (!ids.length) return fail("INVALID_ARGUMENT", "export 缺少服务器 id");
        const files = [];
        for (const serverId of ids) {
            const one = exportContainer(request, serverId, mode === 2 ? 2 : (mode === 1 ? 1 : 0),
                                        target, ids.length === 1);
            if (!one.ok) return one;
            files.push(one.data);
        }
        const totalBytes = files.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
        return ok({ files: files, count: files.length, totalBytes: totalBytes, mode: mode });
    }
    if (method.indexOf("import~") === 0) {
        const parts = method.split("~");
        const file = decodeToken(parts[1] || "");
        if (file === null) return fail("INVALID_ARGUMENT", "导入路径编码无效");
        if (!file) return fail("INVALID_ARGUMENT", "import 缺少文件路径");
        const flags = {};
        for (const pair of String(parts[2] || "").split("&")) {
            const split = pair.split("=");
            if (split[0] === "allowHost") flags.allowHost = split[1] === "1";
            if (split[0] === "allowUntrustedImage") flags.allowUntrustedImage = split[1] === "1";
        }
        return importContainer(request, file, flags);
    }
    return fail("METHOD_NOT_FOUND", "未实现的方法：" + method);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
    if (Buffer.byteLength(line, "utf8") > 4 * 1024 * 1024) {
        return reply(fail("REQUEST_TOO_LARGE", "请求超过 4 MiB 上限"));
    }
    let request = {};
    try {
        request = JSON.parse(line);
    } catch (error) {
        return reply(fail("BAD_JSON", "请求不是合法 JSON", String(error.message || error)));
    }
    let result;
    try {
        result = await handle(request);
    } catch (error) {
        console.error(error && error.stack ? error.stack : error);
        result = fail("INTERNAL_ERROR", "插件内部错误", "详见管理器日志");
    }
    reply(result);
});
