/*
 * 容器搬运工 —— 后端部分（JSON-Line 协议）。
 *
 * 管理器每次调用都会拉起一个 node 进程，从 stdin 读一行 JSON 请求、往 stdout 写一行结果：
 *   { apiVersion, plugin, method, params, caller, pluginsDir, dataDir, requestedAt }
 *
 * 支持的方法（参数直接编码在方法名里，避免命令行里的引号/空格被吃掉）：
 *   export~<服务器id>~<0|1|2>   导出容器包；0=数据+配置，1=再带容器镜像，2=再带备份与日志
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
const path = require("path");
const { spawnSync } = require("child_process");
const readline = require("readline");

const PLUGIN_ID = "com.mcsm.container-porter";
const BUNDLE_FORMAT = "mcsm-container-porter/1";
const PLUGIN_VERSION = "1.0.0";
const TAR = process.platform === "win32" ? "tar.exe" : "tar";
const DOCKER_TIMEOUT = 30 * 60 * 1000;

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

function writeStore(root, data) {
    const file = storeFile(root);
    const temp = file + ".porter-" + process.pid + ".tmp";
    data.version = data.version || 1;
    data.updatedAt = nowIso();
    fs.writeFileSync(temp, JSON.stringify(data), "utf8");
    fs.renameSync(temp, file);
}

function sanitizeRecord(record) {
    const copy = Object.assign({}, record);
    // 这些字段只在原来那台机器上有意义，导入时会重新计算
    delete copy.dir;
    delete copy.status;
    delete copy.lastError;
    delete copy.lastStartAt;
    delete copy.lastBackupAt;
    return copy;
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

function exportContainer(request, serverId, mode) {
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
    tarArgs.push(".");
    const packed = run(TAR, tarArgs, { timeout: DOCKER_TIMEOUT });
    if (!packed.ok) {
        cleanup(work);
        return fail("DATA_PACK_FAILED", "打包服务器目录失败", packed.err || packed.error);
    }

    const manifest = {
        format: BUNDLE_FORMAT,
        createdAt: nowIso(),
        manager: (request && request.managerVersion) || "",
        plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
        image: { ref: imageRef, packaged: packagedImage },
        data: { excluded: excluded, bytes: fs.statSync(dataTar).size },
        server: sanitizeRecord(record)
    };
    fs.writeFileSync(path.join(work, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    const bundleName = slugify(record.name || serverId) + "-" + stamp() + ".tar";
    const bundle = path.join(exportsDir, bundleName);
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

function importContainer(request, file) {
    const root = dataRootOf(request);
    if (!root) return fail("NO_DATA_ROOT", "无法定位管理器数据目录");
    if (!file || !fs.existsSync(file)) return fail("FILE_NOT_FOUND", "找不到容器包", String(file || ""));

    fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
    const work = path.join(root, "tmp", "porter-import-" + stamp() + "-" + process.pid);
    fs.mkdirSync(work, { recursive: true });

    progress("解开容器包 …");
    const unpack = run(TAR, ["-xf", file, "-C", work], { timeout: DOCKER_TIMEOUT });
    if (!unpack.ok) {
        cleanup(work);
        return fail("BUNDLE_INVALID", "无法解开容器包", unpack.err || unpack.error);
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

    let imageRef = (manifest.image && manifest.image.ref) || "";
    let packagedImage = false;
    const imageTar = path.join(work, "image.tar");
    if (fs.existsSync(imageTar)) {
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
    const extracted = run(TAR, ["-xf", dataTar, "-C", targetDir], { timeout: DOCKER_TIMEOUT });
    if (!extracted.ok) {
        cleanup(targetDir);
        cleanup(work);
        return fail("EXTRACT_FAILED", "解压服务器数据失败", extracted.err || extracted.error);
    }

    // 端口可能因为冲突被换掉，server.properties 必须跟记录保持一致
    const propertiesFile = path.join(targetDir, "server.properties");
    if (fs.existsSync(propertiesFile) && (Number(base.port) !== ports.port || Number(base.rconPort) !== ports.rconPort)) {
        let content = fs.readFileSync(propertiesFile, "utf8");
        content = setProperty(content, "server-port", String(ports.port));
        content = setProperty(content, "rcon.port", String(ports.rconPort));
        if (base.rconPassword) content = setProperty(content, "rcon.password", String(base.rconPassword));
        content = setProperty(content, "enable-rcon", "true");
        fs.writeFileSync(propertiesFile, content, "utf8");
    }

    const record = Object.assign({}, base, {
        id: id,
        name: name,
        dir: targetDir,
        port: ports.port,
        rconPort: ports.rconPort,
        status: "stopped",
        lastError: "",
        lastStartAt: "",
        lastBackupAt: "",
        createdAt: nowIso()
    });
    if (record.runtime === "host") {
        record.jdkHome = path.join(targetDir, "jdk");
    } else {
        record.runtime = "docker";
        if (imageRef) record.image = imageRef;
    }
    if (!record.rconPassword && base.rconPassword) record.rconPassword = base.rconPassword;

    servers.push(record);
    try {
        writeStore(root, store.data);
    } catch (error) {
        cleanup(targetDir);
        cleanup(work);
        return fail("STORE_WRITE_FAILED", "写入 servers.json 失败", String(error.message || error));
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

function scanBundles(request) {
    const root = dataRootOf(request);
    if (!root) return fail("NO_DATA_ROOT", "无法定位管理器数据目录");
    const dir = path.join(root, "exports");
    fs.mkdirSync(dir, { recursive: true });

    let names = [];
    try {
        names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".tar"));
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
            stat = fs.statSync(full);
        } catch (error) {
            continue;
        }
        let info = {};
        const manifestRun = run(TAR, ["-xOf", full, "manifest.json"], { timeout: 60000 });
        if (manifestRun.ok) {
            try {
                info = JSON.parse(manifestRun.out);
            } catch (error) {
                info = {};
            }
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
        const serverId = decodeURIComponent(parts[1] || "");
        const mode = Number(parts[2] || 0);
        if (!serverId) return fail("INVALID_ARGUMENT", "export 缺少服务器 id");
        return exportContainer(request, serverId, mode === 2 ? 2 : (mode === 1 ? 1 : 0));
    }
    if (method.indexOf("import~") === 0) {
        const file = decodeURIComponent(method.slice("import~".length));
        if (!file) return fail("INVALID_ARGUMENT", "import 缺少文件路径");
        return importContainer(request, file);
    }
    return fail("METHOD_NOT_FOUND", "未实现的方法：" + method);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
    let request = {};
    try {
        request = JSON.parse(line);
    } catch (error) {
        return reply(fail("BAD_JSON", "请求不是合法 JSON", String(error.message || error)));
    }
    let result;
    try {
        result = handle(request);
    } catch (error) {
        result = fail("INTERNAL_ERROR", "插件内部错误", String((error && error.stack) || error));
    }
    reply(result);
});
