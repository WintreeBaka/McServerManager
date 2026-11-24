#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QMap>
#include <QString>
#include <QVector>

#include "core/JsonUtil.h"

namespace mcsm {

struct ServerRecord;

struct ConfigDiffEntry
{
    QString key;
    QString before;
    QString after;

    QJsonObject toJson() const;
};

struct ConfigBackup
{
    QString id;
    QString file;
    QString note;
    QString createdAt;
    QString mode; // quick | expert | rollback
    QVector<ConfigDiffEntry> changes;

    QJsonObject toJson() const;
};

/// server.properties editing with comment preservation plus a snapshot history
/// so that every change can be rolled back.
class ConfigManager
{
public:
    static QMap<QString, QString> readProperties(const QString &path);
    static QMap<QString, QString> readProperties(const ServerRecord &record);
    /// Reads a properties file and fills in the schema defaults for missing keys, so
    /// two files can be compared the same way the app sees them (readProperties(record)
    /// uses this; without it a file that omits schema keys never compares equal).
    static QMap<QString, QString> readPropertiesWithDefaults(const QString &path);
    static QString readRaw(const QString &path);
    static QString readRaw(const ServerRecord &record);
    static bool isSafePropertyPair(const QString &key, const QString &value, QString *why = nullptr);

    /// Writes only the given keys, leaving every comment and unknown key intact.
    static bool applyValues(const ServerRecord &record,
                            const QMap<QString, QString> &values,
                            const QString &mode,
                            const QString &note,
                            QVector<ConfigDiffEntry> *diff,
                            QString *error);

    /// Expert mode: replaces the whole file after validating it.
    static bool applyRaw(const ServerRecord &record,
                         const QString &text,
                         const QString &note,
                         QVector<ConfigDiffEntry> *diff,
                         QString *error);

    static QStringList validate(const QString &text);
    static QVector<ConfigDiffEntry> diff(const QMap<QString, QString> &before,
                                         const QMap<QString, QString> &after);

    static QVector<ConfigBackup> listBackups(const ServerRecord &record);
    static bool rollback(const ServerRecord &record, const QString &backupId, QString *error);
    static bool ensureBaseline(const ServerRecord &record, QString *error);

private:
    static bool snapshot(const ServerRecord &record,
                         const QString &previousText,
                         const QString &mode,
                         const QString &note,
                         const QVector<ConfigDiffEntry> &changes,
                         QString *error);
};

} // namespace mcsm
