#pragma once

#include <QJsonArray>
#include <QString>
#include <QStringList>
#include <QVector>

namespace mcsm {

/// One capability exposed by the plugin permission registry. The descriptor is
/// consumed by manifest validation, the CLI API catalog, the install dialog and
/// the plugin manager, so wording and risk levels stay consistent everywhere.
struct PluginPermissionSpec
{
    QString id;
    QString label;
    QString description;
    /// low | medium | high | critical
    QString risk;
    /// True for capabilities that can affect users outside the plugin's own
    /// data directory. The install UI requires an explicit opt-in for these.
    bool sensitive = false;
    /// CLI command prefixes authorized by this capability.
    QStringList commandPrefixes;
};

/// Shared, versioned plugin capability registry.
class PluginPermissions
{
public:
    static const QVector<PluginPermissionSpec> &all();
    static const PluginPermissionSpec *find(const QString &id);

    /// Lower-cases, trims, removes duplicates and rejects unknown names.
    static bool normalize(const QStringList &requested, QStringList *normalized,
                          QString *error, QStringList *warnings = nullptr);
    static bool validateDeclared(const QStringList &declared, QString *error,
                                 QStringList *warnings = nullptr);
    static bool isGranted(const QStringList &granted, const QString &permission);
    static QJsonArray catalog();
    static QJsonArray details(const QStringList &declared, const QStringList &granted);

    /// Maps an `mcsm.backend.invoke` argv to the required capability. Returns an
    /// empty string when the command is not exposed to plugins.
    static QString requiredForCommand(const QStringList &arguments);
};

} // namespace mcsm
