#include "server/ServerStore.h"

#include <QDateTime>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLockFile>
#include <QSet>

#include "core/AppPaths.h"
#include "core/Logger.h"
#include "core/StringUtil.h"

namespace mcsm {

ServerStore::ServerStore(const QString &registryPath)
    : m_path(registryPath.isEmpty() ? AppPaths::registryFile() : registryPath)
{
    reload();
}

bool ServerStore::reload()
{
    QFile file(m_path);
    m_lastError.clear();
    if (!file.exists())
        return true;
    if (!file.open(QIODevice::ReadOnly)) {
        Logger::error(QStringLiteral("store"), QStringLiteral("cannot read %1").arg(m_path));
        m_lastError = QStringLiteral("无法读取 %1").arg(m_path);
        return false;
    }
    const QByteArray raw = file.readAll();
    file.close();

    QJsonParseError parseError {};
    const QJsonDocument doc = QJsonDocument::fromJson(raw, &parseError);
    QJsonArray array;
    bool validDocument = false;
    if (doc.isArray()) {
        array = doc.array();
        validDocument = true;
    } else if (doc.isObject() && doc.object().contains(QStringLiteral("servers"))) {
        array = doc.object().value(QStringLiteral("servers")).toArray();
        validDocument = true;
    }
    if (!validDocument) {
        // Never turn a damaged registry into "no servers": the next save would
        // permanently erase every record. Keep the in-memory copy, back up the
        // broken file and report the failure.
        const QString backup = QStringLiteral("%1.broken-%2")
                                   .arg(m_path, QDateTime::currentDateTime().toString(QStringLiteral("yyyyMMdd-HHmmss")));
        QFile::copy(m_path, backup);
        Logger::error(QStringLiteral("store"),
                      QStringLiteral("servers.json 无法解析（%1），已备份到 %2")
                          .arg(parseError.errorString(), backup));
        m_lastError = QStringLiteral("servers.json 无法解析（%1），已备份到 %2")
                          .arg(parseError.errorString(), backup);
        return false;
    }

    QVector<ServerRecord> records;
    for (const QJsonValue &value : array) {
        if (!value.isObject())
            continue;
        ServerRecord record = ServerRecord::fromJson(value.toObject());
        if (record.dir.isEmpty())
            record.dir = AppPaths::serverDir(record.id);
        records.append(record);
    }
    m_records = records;
    return true;
}

bool ServerStore::save() const
{
    // Several mcsm-cli processes (GUI requests + the backup daemon) share this
    // file; a lock prevents two writers from interleaving read/modify/write.
    QLockFile lock(m_path + QStringLiteral(".lock"));
    lock.setStaleLockTime(15000);
    if (!lock.tryLock(5000)) {
        Logger::error(QStringLiteral("store"),
                      QStringLiteral("could not lock %1 for writing").arg(m_path));
        return false;
    }
    QJsonArray array;
    for (const ServerRecord &record : m_records)
        array.append(record.toJson());
    QJsonObject root;
    root.insert(QStringLiteral("version"), 1);
    root.insert(QStringLiteral("updatedAt"), QDateTime::currentDateTime().toString(Qt::ISODate));
    root.insert(QStringLiteral("servers"), array);
    QString error;
    if (!Json::writeObjectFile(m_path, root, &error)) {
        Logger::error(QStringLiteral("store"), error);
        return false;
    }
    return true;
}

int ServerStore::indexOf(const QString &id) const
{
    for (int i = 0; i < m_records.size(); ++i) {
        if (m_records.at(i).id == id)
            return i;
    }
    return -1;
}

bool ServerStore::contains(const QString &id) const
{
    return indexOf(id) >= 0;
}

ServerRecord ServerStore::get(const QString &id) const
{
    const int index = indexOf(id);
    return index >= 0 ? m_records.at(index) : ServerRecord {};
}

bool ServerStore::add(const ServerRecord &record, QString *error)
{
    QString validation;
    if (!record.isValid(&validation) || !validatePorts(record, &validation)) {
        if (error)
            *error = validation;
        return false;
    }
    if (contains(record.id)) {
        if (error)
            *error = QStringLiteral("server id '%1' already exists").arg(record.id);
        return false;
    }
    m_records.append(record);
    if (!save()) {
        m_records.removeLast();
        if (error)
            *error = QStringLiteral("无法写入 servers.json");
        return false;
    }
    return true;
}

bool ServerStore::update(const ServerRecord &record, QString *error)
{
    const int index = indexOf(record.id);
    if (index < 0) {
        if (error)
            *error = QStringLiteral("server '%1' not found").arg(record.id);
        return false;
    }
    QString validation;
    if (!record.isValid(&validation) || !validatePorts(record, &validation)) {
        if (error)
            *error = validation;
        return false;
    }
    const ServerRecord previous = m_records.at(index);
    m_records[index] = record;
    if (!save()) {
        m_records[index] = previous;
        if (error)
            *error = QStringLiteral("无法写入 servers.json");
        return false;
    }
    return true;
}

bool ServerStore::remove(const QString &id, QString *error)
{
    const int index = indexOf(id);
    if (index < 0) {
        if (error)
            *error = QStringLiteral("server '%1' not found").arg(id);
        return false;
    }
    const ServerRecord previous = m_records.at(index);
    m_records.removeAt(index);
    if (!save()) {
        m_records.insert(index, previous);
        if (error)
            *error = QStringLiteral("无法写入 servers.json");
        return false;
    }
    return true;
}

bool ServerStore::validatePorts(const ServerRecord &record, QString *error) const
{
    const auto fail = [error](const QString &message) {
        if (error)
            *error = message;
        return false;
    };
    if (record.port < 1 || record.port > 65535)
        return fail(QStringLiteral("游戏端口 %1 超出 1-65535").arg(record.port));
    if (record.rconPort < 1 || record.rconPort > 65535)
        return fail(QStringLiteral("RCON 端口 %1 超出 1-65535").arg(record.rconPort));
    if (record.port == record.rconPort)
        return fail(QStringLiteral("游戏端口与 RCON 端口不能相同（%1）").arg(record.port));
    for (const ServerRecord &other : m_records) {
        if (other.id == record.id)
            continue;
        if (other.port == record.port || other.rconPort == record.port)
            return fail(QStringLiteral("游戏端口 %1 已被服务器 %2 使用")
                            .arg(record.port).arg(other.name.isEmpty() ? other.id : other.name));
        if (other.port == record.rconPort || other.rconPort == record.rconPort)
            return fail(QStringLiteral("RCON 端口 %1 已被服务器 %2 使用")
                            .arg(record.rconPort).arg(other.name.isEmpty() ? other.id : other.name));
    }
    return true;
}

QString ServerStore::allocateId(const QString &name) const
{
    const QString base = StringUtil::slugify(name);
    QString candidate = base;
    int suffix = 2;
    while (contains(candidate)) {
        candidate = QStringLiteral("%1-%2").arg(base).arg(suffix);
        ++suffix;
    }
    return candidate;
}

int ServerStore::allocatePort(int preferred) const
{
    QSet<int> used;
    for (const ServerRecord &record : m_records) {
        used.insert(record.port);
        used.insert(record.rconPort);
    }
    int port = preferred > 0 ? preferred : 25565;
    while (used.contains(port) && port < 65535)
        ++port;
    return port;
}

int ServerStore::allocateRconPort(int preferred) const
{
    QSet<int> used;
    for (const ServerRecord &record : m_records) {
        used.insert(record.port);
        used.insert(record.rconPort);
    }
    int port = preferred > 0 ? preferred : 25575;
    while (used.contains(port) && port < 65535)
        ++port;
    return port;
}

} // namespace mcsm
