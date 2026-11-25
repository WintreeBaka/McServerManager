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
    static QString toNativePath(const QString &path);
    static QByteArray toDockerPath(const QString &path);
};

} // namespace mcsm
