#include "cli/ConfirmationService.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QSaveFile>

#include "core/AppPaths.h"

namespace mcsm {
namespace {

constexpr qint64 kChallengeLifetimeSeconds = 5 * 60;
constexpr int kMaximumAttempts = 5;

QString randomHex(int bytes)
{
    QByteArray data(bytes, Qt::Uninitialized);
    for (int i = 0; i < bytes; ++i)
        data[i] = char(QRandomGenerator::system()->bounded(256));
    return QString::fromLatin1(data.toHex());
}

bool writeObject(const QString &path, const QJsonObject &object)
{
    QSaveFile file(path);
    if (!file.open(QIODevice::WriteOnly))
        return false;
#ifndef Q_OS_WIN
    file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
#endif
    const QByteArray bytes = QJsonDocument(object).toJson(QJsonDocument::Compact);
    return file.write(bytes) == bytes.size() && file.commit();
}

} // namespace

QString ConfirmationService::confirmationDir()
{
    return QDir(AppPaths::tmpDir()).filePath(QStringLiteral("confirmations"));
}

bool ConfirmationService::validAction(const QString &action)
{
    static const QRegularExpression pattern(QStringLiteral("^[a-z][a-z0-9._-]{2,63}$"));
    return pattern.match(action).hasMatch();
}

bool ConfirmationService::validTarget(const QString &target)
{
    return !target.trimmed().isEmpty() && target.size() <= 512
           && !target.contains(QLatin1Char('\n')) && !target.contains(QLatin1Char('\r'));
}

void ConfirmationService::pruneExpired()
{
    const QDir dir(confirmationDir());
    const qint64 now = QDateTime::currentSecsSinceEpoch();
    const QFileInfoList files = dir.entryInfoList({QStringLiteral("*.json")}, QDir::Files);
    for (const QFileInfo &info : files) {
        QFile file(info.absoluteFilePath());
        bool remove = info.lastModified().toSecsSinceEpoch() < now - 600;
        if (!remove && file.open(QIODevice::ReadOnly)) {
            const QJsonObject object =
                Json::parseObject(file.read(16 * 1024), nullptr);
            remove = Json::bigint(object, QStringLiteral("expiresAt"), 0) <= now;
        }
        if (remove)
            QFile::remove(info.absoluteFilePath());
    }
}

Result ConfirmationService::issue(const QString &action, const QString &target)
{
    if (!validAction(action))
        return Result::fail(QStringLiteral("INVALID_ARGUMENT"),
                            QStringLiteral("确认动作名称不合法"));
    if (!validTarget(target))
        return Result::fail(QStringLiteral("INVALID_ARGUMENT"),
                            QStringLiteral("确认目标为空或过长"));

    QString dirError;
    const QString dir = confirmationDir();
    if (!QDir().mkpath(dir)) {
        dirError = QStringLiteral("无法创建确认码目录：%1").arg(dir);
        return Result::fail(QStringLiteral("IO_ERROR"),
                            QStringLiteral("无法生成删除确认码"), dirError);
    }
    pruneExpired();

    const QString token = randomHex(16);
    const int number = int(QRandomGenerator::system()->bounded(100000000));
    const QString code = QStringLiteral("%1").arg(number, 8, 10, QLatin1Char('0'));
    const qint64 now = QDateTime::currentSecsSinceEpoch();
    const qint64 expiresAt = now + kChallengeLifetimeSeconds;

    QJsonObject challenge {
        {QStringLiteral("action"), action},
        {QStringLiteral("target"), target},
        {QStringLiteral("code"), code},
        {QStringLiteral("attempts"), 0},
        {QStringLiteral("createdAt"), now},
        {QStringLiteral("expiresAt"), expiresAt},
    };
    const QString path = QDir(dir).filePath(token + QStringLiteral(".json"));
    if (!writeObject(path, challenge)) {
        return Result::fail(QStringLiteral("IO_ERROR"),
                            QStringLiteral("无法保存删除确认码"));
    }

    return Result::ok(QJsonObject {
        {QStringLiteral("token"), token},
        {QStringLiteral("code"), code},
        {QStringLiteral("action"), action},
        {QStringLiteral("target"), target},
        {QStringLiteral("expiresAt"),
         QDateTime::fromSecsSinceEpoch(expiresAt).toString(Qt::ISODate)},
        {QStringLiteral("expiresInSeconds"), kChallengeLifetimeSeconds},
    });
}

Result ConfirmationService::consume(const QString &action,
                                    const QString &target,
                                    const QString &token,
                                    const QString &code)
{
    static const QRegularExpression tokenPattern(QStringLiteral("^[a-f0-9]{32}$"));
    if (!tokenPattern.match(token).hasMatch()) {
        return Result::fail(QStringLiteral("CONFIRMATION_INVALID"),
                            QStringLiteral("删除确认码无效或已过期"));
    }

    const QString path = QDir(confirmationDir()).filePath(token + QStringLiteral(".json"));
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly) || file.size() <= 0 || file.size() > 16 * 1024) {
        return Result::fail(QStringLiteral("CONFIRMATION_INVALID"),
                            QStringLiteral("删除确认码无效或已过期"));
    }
    bool parsed = false;
    const QJsonObject challenge = Json::parseObject(file.readAll(), &parsed);
    file.close();
    if (!parsed) {
        QFile::remove(path);
        return Result::fail(QStringLiteral("CONFIRMATION_INVALID"),
                            QStringLiteral("删除确认码无效或已过期"));
    }

    const qint64 now = QDateTime::currentSecsSinceEpoch();
    if (Json::bigint(challenge, QStringLiteral("expiresAt"), 0) <= now) {
        QFile::remove(path);
        return Result::fail(QStringLiteral("CONFIRMATION_EXPIRED"),
                            QStringLiteral("删除确认码已过期，请重新发起删除"));
    }
    if (Json::str(challenge, QStringLiteral("action")) != action
        || Json::str(challenge, QStringLiteral("target")) != target) {
        return Result::fail(QStringLiteral("CONFIRMATION_INVALID"),
                            QStringLiteral("确认码与当前删除目标不匹配"));
    }

    const int attempts = Json::integer(challenge, QStringLiteral("attempts"));
    if (attempts >= kMaximumAttempts) {
        QFile::remove(path);
        return Result::fail(QStringLiteral("CONFIRMATION_LOCKED"),
                            QStringLiteral("确认码尝试次数过多，请重新发起删除"));
    }
    if (code != Json::str(challenge, QStringLiteral("code"))) {
        QJsonObject updated = challenge;
        updated.insert(QStringLiteral("attempts"), attempts + 1);
        writeObject(path, updated);
        return Result::fail(QStringLiteral("CONFIRMATION_INVALID"),
                            QStringLiteral("确认码不正确，请核对后重试"));
    }

    if (!QFile::remove(path)) {
        return Result::fail(QStringLiteral("IO_ERROR"),
                            QStringLiteral("无法完成确认码的一次性消费"));
    }
    return Result::ok(QJsonObject {{QStringLiteral("confirmed"), true},
                                   {QStringLiteral("action"), action},
                                   {QStringLiteral("target"), target}});
}

} // namespace mcsm
