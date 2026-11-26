#include "core/ProcessRunner.h"

#include <QDir>
#include <QEventLoop>
#include <QFileInfo>
#include <QScopeGuard>
#include <QStandardPaths>
#include <QTcpSocket>
#include <QThread>
#include <QTimer>

#include "core/Logger.h"
#include "core/StringUtil.h"

#ifdef Q_OS_WIN
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace mcsm {
namespace {

thread_local int g_processRunDepth = 0;
constexpr int kMaxProcessRunDepth = 4;

} // namespace

QString ProcessResult::combined() const
{
    QString text = stdOut;
    if (!stdErr.isEmpty()) {
        if (!text.isEmpty() && !text.endsWith(QLatin1Char('\n')))
            text.append(QLatin1Char('\n'));
        text.append(stdErr);
    }
    return text;
}

QString ProcessResult::errorText() const
{
    if (!started)
        return QStringLiteral("cannot start '%1'").arg(program);
    if (timedOut)
        return QStringLiteral("'%1 %2' timed out").arg(program, StringUtil::joinArgs(arguments));
    QString text = stdErr.trimmed();
    if (text.isEmpty())
        text = stdOut.trimmed();
    if (text.isEmpty())
        text = QStringLiteral("exit code %1").arg(exitCode);
    return StringUtil::ellipsize(text, 800);
}

ProcessResult ProcessRunner::run(const QString &program,
                                 const QStringList &arguments,
                             int timeoutMs,
                             const QByteArray &stdinData,
                             const QString &workingDirectory,
                             const QProcessEnvironment &environment)
{
    ProcessResult result;
    result.program = program;
    result.arguments = arguments;
    if (g_processRunDepth >= kMaxProcessRunDepth) {
        Logger::error(QStringLiteral("process"),
                      QStringLiteral("refusing recursive process launch: %1 %2")
                          .arg(program, StringUtil::joinArgs(arguments)));
        return result;
    }
    ++g_processRunDepth;
    const auto depthGuard = qScopeGuard([&] { --g_processRunDepth; });

    QProcess process;
    process.setProgram(program);
    process.setArguments(arguments);
    if (!workingDirectory.isEmpty())
        process.setWorkingDirectory(workingDirectory);
    if (!environment.isEmpty())
        process.setProcessEnvironment(environment);
    process.setProcessChannelMode(QProcess::SeparateChannels);
#if defined(Q_OS_UNIX)
    // Give each command its own process group so a timeout can terminate all
    // helpers spawned by installers and plugins, not only the direct child.
    process.setChildProcessModifier([] { ::setpgid(0, 0); });
#endif
    Logger::debug(QStringLiteral("process"),
                  QStringLiteral("exec: %1 %2 (cwd=%3)")
                      .arg(program, StringUtil::joinArgs(arguments),
                           workingDirectory.isEmpty() ? QDir::currentPath() : workingDirectory));

    process.start();
    if (!process.waitForStarted(15000)) {
        result.started = false;
        Logger::warn(QStringLiteral("process"),
                     QStringLiteral("failed to start %1: %2").arg(program, process.errorString()));
        return result;
    }
    result.started = true;

    if (!stdinData.isEmpty()) {
        process.write(stdinData);
        process.closeWriteChannel();
    }

    if (!process.waitForFinished(timeoutMs)) {
        result.timedOut = true;
        const qint64 pid = process.processId();
        if (pid > 0)
            killProcess(pid, true);
        process.kill();
        process.waitForFinished(3000);
    }

    result.exitCode = process.exitCode();
    result.stdOut = QString::fromUtf8(process.readAllStandardOutput());
    result.stdErr = QString::fromUtf8(process.readAllStandardError());
    return result;
}

bool ProcessRunner::startDetachedOk(const QString &program,
                                    const QStringList &arguments,
                                    const QString &workingDirectory,
                                    qint64 *pid)
{
    qint64 childPid = 0;
    const bool started = QProcess::startDetached(program, arguments, workingDirectory, &childPid);
    if (pid)
        *pid = childPid;
    if (!started) {
        Logger::warn(QStringLiteral("process"),
                     QStringLiteral("failed to start detached: %1").arg(program));
    }
    return started;
}

bool ProcessRunner::programExists(const QString &program)
{
    if (program.isEmpty())
        return false;
    if (QFileInfo(program).isAbsolute())
        return QFileInfo::exists(program);
#ifdef Q_OS_WIN
    const QStringList extensions = QStringList {QStringLiteral(".exe"), QStringLiteral(".cmd"),
                                                 QStringLiteral(".bat"), QString()};
    const QStringList dirs = qEnvironmentVariable("PATH").split(QLatin1Char(';'), Qt::SkipEmptyParts);
    for (const QString &dir : dirs) {
        for (const QString &ext : extensions) {
            const QString candidate = QDir(dir).filePath(program + ext);
            if (QFileInfo::exists(candidate))
                return true;
        }
    }
    return false;
#else
    return !QStandardPaths::findExecutable(program).isEmpty();
#endif
}

QString ProcessRunner::resolveProgram(const QStringList &candidates)
{
    for (const QString &candidate : candidates) {
        if (programExists(candidate))
            return candidate;
    }
    return QString();
}

bool ProcessRunner::processAlive(qint64 pid)
{
    if (pid <= 0)
        return false;
#ifdef Q_OS_WIN
    HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, DWORD(pid));
    if (!handle)
        return false;
    DWORD code = 0;
    const bool alive = GetExitCodeProcess(handle, &code) && code == STILL_ACTIVE;
    CloseHandle(handle);
    return alive;
#else
    return ::kill(pid_t(pid), 0) == 0 || errno == EPERM;
#endif
}

QString ProcessRunner::processImage(qint64 pid)
{
    if (!processAlive(pid))
        return QString();
#ifdef Q_OS_WIN
    HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, DWORD(pid));
    if (!handle)
        return QString();
    wchar_t buffer[32768] {};
    DWORD size = DWORD(std::size(buffer));
    QString path;
    if (QueryFullProcessImageNameW(handle, 0, buffer, &size))
        path = QString::fromWCharArray(buffer, int(size));
    CloseHandle(handle);
    return QFileInfo(path).fileName();
#else
    QFile file(QStringLiteral("/proc/%1/comm").arg(pid));
    if (!file.open(QIODevice::ReadOnly))
        return QString();
    return QString::fromUtf8(file.readAll()).trimmed();
#endif
}

QString ProcessRunner::processCommandLine(qint64 pid)
{
    if (!processAlive(pid))
        return QString();
#ifdef Q_OS_WIN
    const QString script =
        QStringLiteral("(Get-CimInstance Win32_Process -Filter \"ProcessId=%1\").CommandLine").arg(pid);
    const ProcessResult result =
        run(QStringLiteral("powershell"),
            {QStringLiteral("-NoProfile"), QStringLiteral("-Command"), script}, 10000);
    return result.ok() ? result.stdOut.trimmed() : QString();
#else
    QFile file(QStringLiteral("/proc/%1/cmdline").arg(pid));
    if (!file.open(QIODevice::ReadOnly))
        return QString();
    QByteArray bytes = file.readAll();
    bytes.replace('\0', ' ');
    return QString::fromLocal8Bit(bytes).trimmed();
#endif
}

bool ProcessRunner::processMatches(qint64 pid, const QString &image)
{
    if (!processAlive(pid))
        return false;
    if (image.trimmed().isEmpty())
        return false;
    const QString actual = processImage(pid);
    return !actual.isEmpty() && actual.compare(QFileInfo(image).fileName(), Qt::CaseInsensitive) == 0;
}

bool ProcessRunner::portOpen(quint16 port, int timeoutMs)
{
    if (port == 0)
        return false;
    QTcpSocket socket;
    socket.connectToHost(QStringLiteral("127.0.0.1"), port);
    const bool connected = socket.waitForConnected(timeoutMs);
    socket.abort();
    return connected;
}

bool ProcessRunner::killProcess(qint64 pid, bool tree, int timeoutMs)
{
    if (pid <= 0)
        return false;
#ifdef Q_OS_WIN
    QStringList arguments {QStringLiteral("/PID"), QString::number(pid)};
    if (tree)
        arguments << QStringLiteral("/T");
    arguments << QStringLiteral("/F");
    const ProcessResult result = run(QStringLiteral("taskkill"), arguments, timeoutMs);
    return result.ok() || !processAlive(pid);
#else
    const pid_t target = pid_t(pid);
    const auto signalTarget = [target, tree](int signal) {
        if (tree && ::kill(-target, signal) == 0)
            return true;
        return ::kill(target, signal) == 0;
    };
    if (!signalTarget(SIGTERM))
        return !processAlive(pid);
    for (int waited = 0; waited < qMax(0, timeoutMs); waited += 50) {
        if (!processAlive(pid))
            return true;
        QThread::msleep(50);
    }
    signalTarget(SIGKILL);
    for (int waited = 0; waited < 3000; waited += 50) {
        if (!processAlive(pid))
            return true;
        QThread::msleep(50);
    }
    return !processAlive(pid);
#endif
}

QString ProcessRunner::toNativePath(const QString &path)
{
#ifdef Q_OS_WIN
    return QDir::toNativeSeparators(path);
#else
    return path;
#endif
}

QByteArray ProcessRunner::toDockerPath(const QString &path)
{
    // Docker Desktop on Windows accepts "C:/dir/sub" style paths for bind mounts.
    QString converted = path;
    converted.replace(QLatin1Char('\\'), QLatin1Char('/'));
    return converted.toLocal8Bit();
}

} // namespace mcsm
