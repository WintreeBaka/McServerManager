#pragma once

#include <QByteArray>
#include <QProcess>
#include <QProcessEnvironment>
#include <QString>
#include <QStringList>

namespace mcsm {

struct ProcessResult
{
    bool started = false;
    bool timedOut = false;
    int exitCode = -1;
    QString program;
    QStringList arguments;
    QString stdOut;
    QString stdErr;

    bool ok() const { return started && !timedOut && exitCode == 0; }
    QString combined() const;
    QString errorText() const;
};

class ProcessRunner
{
public:
    static ProcessResult run(const QString &program,
                             const QStringList &arguments,
                             int timeoutMs = 120000,
                             const QByteArray &stdinData = QByteArray(),
                             const QString &workingDirectory = QString(),
                             const QProcessEnvironment &environment = QProcessEnvironment());

    static bool startDetachedOk(const QString &program,
                                const QStringList &arguments,
                                const QString &workingDirectory = QString(),
                                qint64 *pid = nullptr);

    static bool programExists(const QString &program);
    static QString resolveProgram(const QStringList &candidates);
    static bool processAlive(qint64 pid);
    /// Image name of a live process, or empty when it cannot be determined.
    static QString processImage(qint64 pid);
    static QString processCommandLine(qint64 pid);
    /// Verifies a PID was not reused before signalling it. An unknown image is
    /// treated as a mismatch; callers can fall back to stronger command checks.
    static bool processMatches(qint64 pid, const QString &image);
    static bool portOpen(quint16 port, int timeoutMs = 500);
    static bool killProcess(qint64 pid, bool tree = true, int timeoutMs = 30000);
    static QString toNativePath(const QString &path);
    static QByteArray toDockerPath(const QString &path);
};

} // namespace mcsm
