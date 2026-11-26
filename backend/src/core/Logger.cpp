#include "core/Logger.h"

#include <QDateTime>
#include <QDebug>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QMutex>
#include <QMutexLocker>
#include <QTextStream>

#include "core/AppPaths.h"

namespace mcsm {
namespace {

QMutex g_mutex;
bool g_verbose = false;
bool g_quiet = false;
QString g_context;
QString g_lastError;
QByteArray g_pendingFileOutput;
QElapsedTimer g_flushTimer;

void flushFileOutputLocked()
{
    if (g_pendingFileOutput.isEmpty())
        return;
    const QString path = AppPaths::logFilePath();
    QDir().mkpath(QFileInfo(path).absolutePath());
    QFile file(path);
    if (file.open(QIODevice::WriteOnly | QIODevice::Append)) {
        file.write(g_pendingFileOutput);
        file.close();
    }
    g_pendingFileOutput.clear();
    g_flushTimer.restart();

    if (QFileInfo(path).size() <= 8LL * 1024 * 1024)
        return;
    QFile::remove(path + QStringLiteral(".3"));
    for (int generation = 2; generation >= 1; --generation) {
        const QString source = path + QStringLiteral(".%1").arg(generation);
        const QString target = path + QStringLiteral(".%1").arg(generation + 1);
        QFile::remove(target);
        if (QFileInfo::exists(source))
            QFile::rename(source, target);
    }
    QFile::rename(path, path + QStringLiteral(".1"));
}

QString levelName(LogLevel level)
{
    switch (level) {
    case LogLevel::Debug: return QStringLiteral("debug");
    case LogLevel::Info:  return QStringLiteral("info");
    case LogLevel::Warn:  return QStringLiteral("warn");
    case LogLevel::Error: return QStringLiteral("error");
    }
    return QStringLiteral("info");
}

} // namespace

void Logger::init(bool verbose, bool quiet)
{
    QMutexLocker locker(&g_mutex);
    flushFileOutputLocked();
    g_verbose = verbose;
    g_quiet = quiet;
}

void Logger::flush()
{
    QMutexLocker locker(&g_mutex);
    flushFileOutputLocked();
}

void Logger::setCommandContext(const QString &context)
{
    QMutexLocker locker(&g_mutex);
    g_context = context;
}

void Logger::log(LogLevel level, const QString &scope, const QString &message)
{
    QMutexLocker locker(&g_mutex);

    if (level == LogLevel::Debug && !g_verbose)
        return;
    if (level == LogLevel::Error)
        g_lastError = message;

    const QString stamp = QDateTime::currentDateTime().toString(Qt::ISODate);
    QString line = QStringLiteral("[%1] %2 %3: %4")
                       .arg(stamp, levelName(level).toUpper().leftJustified(5), scope, message);
    if (!g_context.isEmpty())
        line = QStringLiteral("%1 (%2)").arg(line, g_context);

    const bool toStderr = (level == LogLevel::Error || level == LogLevel::Warn || g_verbose) && !g_quiet;
    if (toStderr) {
        const QByteArray utf8 = line.toUtf8();
        fputs(utf8.constData(), stderr);
        fputc('\n', stderr);
        fflush(stderr);
    }

    g_pendingFileOutput += line.toUtf8();
    g_pendingFileOutput += '\n';
    const bool shouldFlush = level == LogLevel::Warn || level == LogLevel::Error
        || g_pendingFileOutput.size() >= 64 * 1024 || !g_flushTimer.isValid()
        || g_flushTimer.elapsed() >= 500;
    if (shouldFlush)
        flushFileOutputLocked();
}

void Logger::debug(const QString &scope, const QString &message) { log(LogLevel::Debug, scope, message); }
void Logger::info(const QString &scope, const QString &message) { log(LogLevel::Info, scope, message); }
void Logger::warn(const QString &scope, const QString &message) { log(LogLevel::Warn, scope, message); }
void Logger::error(const QString &scope, const QString &message) { log(LogLevel::Error, scope, message); }

QString Logger::lastError()
{
    QMutexLocker locker(&g_mutex);
    return g_lastError;
}

} // namespace mcsm
