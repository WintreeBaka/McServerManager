#include "server/ServerStore.h"

#include <QDateTime>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLockFile>
#include <QMutex>
#include <QMutexLocker>
#include <QSet>

#ifdef Q_OS_WIN
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <aclapi.h>
#endif

#include "core/AppPaths.h"
#include "core/Logger.h"
#include "core/StringUtil.h"

namespace mcsm {
namespace {

QMutex s_registryMutex;

bool restrictRegistryPermissions(const QString &path)
{
#ifdef Q_OS_WIN
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
        return false;
    DWORD needed = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &needed);
    if (!needed) {
        CloseHandle(token);
        return false;
    }
    QByteArray buffer(int(needed), Qt::Uninitialized);
    if (!GetTokenInformation(token, TokenUser, buffer.data(), needed, &needed)) {
        CloseHandle(token);
        return false;
    }
    CloseHandle(token);
    auto *tokenUser = reinterpret_cast<TOKEN_USER *>(buffer.data());

    PSID owner = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const DWORD ownerStatus = GetNamedSecurityInfoW(
        const_cast<LPWSTR>(reinterpret_cast<LPCWSTR>(path.utf16())),
        SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner, nullptr, nullptr, nullptr, &descriptor);
    if (ownerStatus != ERROR_SUCCESS)
        return false;

    EXPLICIT_ACCESS_W access[2] {};
    int count = 0;
    auto addAccess = [&](PSID sid) {
        access[count].grfAccessPermissions = FILE_ALL_ACCESS;
        access[count].grfAccessMode = SET_ACCESS;
        access[count].grfInheritance = NO_INHERITANCE;
        access[count].Trustee.TrusteeForm = TRUSTEE_IS_SID;
        access[count].Trustee.TrusteeType = TRUSTEE_IS_USER;
        access[count].Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid);
        ++count;
    };
    if (owner)
        addAccess(owner);
    if (!owner || !EqualSid(owner, tokenUser->User.Sid))
        addAccess(tokenUser->User.Sid);

    PACL acl = nullptr;
    const DWORD aclStatus = SetEntriesInAclW(DWORD(count), access, nullptr, &acl);
    LocalFree(descriptor);
    if (aclStatus != ERROR_SUCCESS)
        return false;
    const DWORD result = SetNamedSecurityInfoW(
        const_cast<LPWSTR>(reinterpret_cast<LPCWSTR>(path.utf16())),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        nullptr, nullptr, acl, nullptr);
    LocalFree(acl);
    return result == ERROR_SUCCESS;
#else
    return QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
#endif
}

} // namespace

ServerStore::ServerStore(const QString &registryPath)
    : m_path(registryPath.isEmpty() ? AppPaths::registryFile() : registryPath)
{
    reload();
}

bool ServerStore::reloadFile(QString *error)
{
    QFile file(m_path);
    m_lastError.clear();
    if (!file.exists())
        return true;
    if (!file.open(QIODevice::ReadOnly)) {
        Logger::error(QStringLiteral("store"), QStringLiteral("cannot read %1").arg(m_path));
        m_lastError = QStringLiteral("无法读取 %1").arg(m_path);
        if (error)
            *error = m_lastError;
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
        if (error)
            *error = m_lastError;
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
    if (!restrictRegistryPermissions(m_path)) {
        Logger::warn(QStringLiteral("store"),
                     QStringLiteral("could not restrict %1 after reload").arg(m_path));
    }
    return true;
}

bool ServerStore::reload()
{
    QMutexLocker processLock(&s_registryMutex);
    return reloadFile();
}

bool ServerStore::writeFileLocked(QString *error) const
{
    QLockFile lock(m_path + QStringLiteral(".lock"));
    lock.setStaleLockTime(15000);
    if (!lock.tryLock(5000)) {
        Logger::error(QStringLiteral("store"),
                      QStringLiteral("could not lock %1 for writing").arg(m_path));
        if (error)
            *error = QStringLiteral("无法锁定 servers.json");
        return false;
    }
    QJsonArray array;
    for (const ServerRecord &record : m_records)
        array.append(record.toJson(false));
    QJsonObject root;
    root.insert(QStringLiteral("version"), 1);
    root.insert(QStringLiteral("updatedAt"), QDateTime::currentDateTime().toString(Qt::ISODate));
    root.insert(QStringLiteral("servers"), array);
    QString writeError;
    if (!Json::writeObjectFile(m_path, root, &writeError)) {
        Logger::error(QStringLiteral("store"), writeError);
        if (error)
            *error = QStringLiteral("无法写入 servers.json");
        return false;
    }
    if (!restrictRegistryPermissions(m_path)) {
        Logger::warn(QStringLiteral("store"),
                     QStringLiteral("could not restrict %1 to the current user").arg(m_path));
    }
    return true;
}

bool ServerStore::save() const
{
    QMutexLocker processLock(&s_registryMutex);
    return writeFileLocked();
}

bool ServerStore::transaction(const std::function<bool(QString *)> &mutation, QString *error)
{
    QMutexLocker processLock(&s_registryMutex);
    QLockFile lock(m_path + QStringLiteral(".lock"));
    lock.setStaleLockTime(15000);
    if (!lock.tryLock(5000)) {
        Logger::warn(QStringLiteral("store"),
                     QStringLiteral("could not lock %1 for transaction").arg(m_path));
        if (error)
            *error = QStringLiteral("无法锁定 servers.json");
        return false;
    }

    const QVector<ServerRecord> previous = m_records;
    if (!reloadFile(error)) {
        m_records = previous;
        return false;
    }
    if (!mutation(error)) {
        Logger::warn(QStringLiteral("store"),
                     QStringLiteral("registry mutation rejected: %1")
                         .arg(error ? *error : QStringLiteral("unknown validation error")));
        m_records = previous;
        return false;
    }
    // writeFileLocked acquires a second QLockFile instance, which would deadlock
    // while the transaction lock is held. Write the validated snapshot directly.
    QJsonArray array;
    for (const ServerRecord &record : m_records)
        array.append(record.toJson(false));
    QJsonObject root;
    root.insert(QStringLiteral("version"), 1);
    root.insert(QStringLiteral("updatedAt"), QDateTime::currentDateTime().toString(Qt::ISODate));
    root.insert(QStringLiteral("servers"), array);
    QString writeError;
    if (!Json::writeObjectFile(m_path, root, &writeError)) {
        Logger::error(QStringLiteral("store"), writeError);
        m_records = previous;
        if (error)
            *error = writeError;
        return false;
    }
    if (!restrictRegistryPermissions(m_path))
        Logger::warn(QStringLiteral("store"),
                     QStringLiteral("could not restrict %1 to the current user").arg(m_path));
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
    return transaction([this, &record](QString *validation) {
        if (!record.isValid(validation) || !validatePorts(record, validation))
            return false;
        if (contains(record.id)) {
            if (validation)
                *validation = QStringLiteral("server id '%1' already exists").arg(record.id);
            return false;
        }
        m_records.append(record);
        return true;
    }, error);
}

bool ServerStore::update(const ServerRecord &record, QString *error)
{
    return transaction([this, &record](QString *validation) {
        const int index = indexOf(record.id);
        if (index < 0) {
            if (validation)
                *validation = QStringLiteral("server '%1' not found").arg(record.id);
            return false;
        }
        if (!record.isValid(validation) || !validatePorts(record, validation))
            return false;
        m_records[index] = record;
        return true;
    }, error);
}

bool ServerStore::remove(const QString &id, QString *error)
{
    return transaction([this, &id](QString *validation) {
        const int index = indexOf(id);
        if (index < 0) {
            if (validation)
                *validation = QStringLiteral("server '%1' not found").arg(id);
            return false;
        }
        m_records.removeAt(index);
        return true;
    }, error);
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
