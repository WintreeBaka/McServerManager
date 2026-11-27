#include "plugin/PluginPermissions.h"

#include <QJsonObject>
#include <QSet>

namespace mcsm {

const QVector<PluginPermissionSpec> &PluginPermissions::all()
{
    static const QVector<PluginPermissionSpec> specs = {
        {QStringLiteral("ui.pages"), QStringLiteral("插件页面"),
         QStringLiteral("注册页面、按钮、通知，并向该插件自己的页面推送内容。"),
         QStringLiteral("low"), false, {}},
        {QStringLiteral("settings.read"), QStringLiteral("读取管理器设置"),
         QStringLiteral("读取管理器设置中的非插件私有键；插件自己的数据始终可读写。"),
         QStringLiteral("medium"), true, {QStringLiteral("settings get")}},
        {QStringLiteral("servers.read"), QStringLiteral("读取服务器"),
         QStringLiteral("列出服务器并读取状态、日志、配置和详情。"),
         QStringLiteral("medium"), true,
         {QStringLiteral("server list"), QStringLiteral("server get"),
          QStringLiteral("server status"), QStringLiteral("server logs"),
          QStringLiteral("config schema"), QStringLiteral("config read"),
          QStringLiteral("config raw"), QStringLiteral("config validate"),
          QStringLiteral("backup list")}},
        {QStringLiteral("servers.control"), QStringLiteral("控制服务器进程"),
         QStringLiteral("启动、停止、重启或强制结束服务器。"),
         QStringLiteral("high"), true,
         {QStringLiteral("server start"), QStringLiteral("server stop"),
          QStringLiteral("server restart"), QStringLiteral("server kill")}},
        {QStringLiteral("console.send"), QStringLiteral("发送控制台命令"),
         QStringLiteral("通过 RCON 向服务器控制台发送任意命令。"),
         QStringLiteral("high"), true, {QStringLiteral("server command")}},
        {QStringLiteral("server.delete"), QStringLiteral("删除服务器"),
         QStringLiteral("永久删除服务器记录及其目录。"),
         QStringLiteral("critical"), true, {QStringLiteral("server delete")}},
        {QStringLiteral("config.write"), QStringLiteral("修改服务器配置"),
         QStringLiteral("写入 server.properties 或回滚配置。"),
         QStringLiteral("high"), true,
         {QStringLiteral("config apply"), QStringLiteral("config rollback")}},
        {QStringLiteral("backup.manage"), QStringLiteral("管理服务器备份"),
         QStringLiteral("创建、恢复、删除或调度服务器备份。"),
         QStringLiteral("high"), true,
         {QStringLiteral("backup create"), QStringLiteral("backup restore"),
          QStringLiteral("backup remove"), QStringLiteral("backup schedule")}},
        {QStringLiteral("server.start.patch"), QStringLiteral("调整服务器启动参数"),
         QStringLiteral("生命周期钩子可以修改 JVM、环境变量和容器启动参数。"),
         QStringLiteral("high"), true, {}},
        {QStringLiteral("filesystem.server.read"), QStringLiteral("读取服务器文件"),
         QStringLiteral("读取 managed servers 目录下的文件。"),
         QStringLiteral("high"), true, {}},
        {QStringLiteral("filesystem.server.write"), QStringLiteral("修改服务器文件"),
         QStringLiteral("写入 managed servers 目录下的文件。"),
         QStringLiteral("critical"), true, {}},
        {QStringLiteral("process.spawn"), QStringLiteral("启动外部进程"),
         QStringLiteral("从插件后端启动其它程序。该权限可绕过部分运行时限制。"),
         QStringLiteral("critical"), true, {}},
        {QStringLiteral("network.outbound"), QStringLiteral("访问外部网络"),
         QStringLiteral("允许插件后端主动连接外部网络服务。"),
         QStringLiteral("high"), true, {}},
        {QStringLiteral("docker.args"), QStringLiteral("自定义 Docker 参数"),
         QStringLiteral("向服务器容器启动命令追加经过管理器白名单检查的参数。"),
         QStringLiteral("critical"), true, {}},
        {QStringLiteral("web.service"), QStringLiteral("启动本地 Web 服务"),
         QStringLiteral("启动插件声明的本地 Web 面板服务。"),
         QStringLiteral("high"), true, {}},
        {QStringLiteral("filesystem.data"), QStringLiteral("插件私有数据（兼容）"),
         QStringLiteral("旧 API 名称；插件自己的数据目录始终可读写，无需申请。"),
         QStringLiteral("low"), false, {}},
    };
    return specs;
}

const PluginPermissionSpec *PluginPermissions::find(const QString &id)
{
    const QString normalized = id.trimmed().toLower();
    for (const PluginPermissionSpec &spec : all()) {
        if (spec.id == normalized)
            return &spec;
    }
    return nullptr;
}

bool PluginPermissions::normalize(const QStringList &requested, QStringList *normalized,
                                  QString *error, QStringList *warnings)
{
    QStringList result;
    QSet<QString> seen;
    for (const QString &raw : requested) {
        const QString id = raw.trimmed().toLower();
        if (id.isEmpty())
            continue;
        if (!find(id)) {
            if (error)
                *error = QStringLiteral("未知插件权限：%1").arg(raw);
            return false;
        }
        if (seen.contains(id))
            continue;
        seen.insert(id);
        result.append(id);
        if (id == QLatin1String("filesystem.data") && warnings)
            *warnings << QStringLiteral("filesystem.data 是旧权限名；插件私有数据始终允许，无需声明");
    }
    result.sort();
    if (normalized)
        *normalized = result;
    return true;
}

bool PluginPermissions::validateDeclared(const QStringList &declared, QString *error,
                                         QStringList *warnings)
{
    QStringList ignored;
    return normalize(declared, &ignored, error, warnings);
}

bool PluginPermissions::isGranted(const QStringList &granted, const QString &permission)
{
    return granted.contains(permission.trimmed().toLower(), Qt::CaseInsensitive);
}

QJsonArray PluginPermissions::catalog()
{
    QJsonArray array;
    for (const PluginPermissionSpec &spec : all()) {
        array.append(QJsonObject {
            {QStringLiteral("id"), spec.id},
            {QStringLiteral("label"), spec.label},
            {QStringLiteral("description"), spec.description},
            {QStringLiteral("risk"), spec.risk},
            {QStringLiteral("sensitive"), spec.sensitive},
            {QStringLiteral("commandPrefixes"), QJsonArray::fromStringList(spec.commandPrefixes)},
        });
    }
    return array;
}

QJsonArray PluginPermissions::details(const QStringList &declared, const QStringList &granted)
{
    QJsonArray array;
    for (const QString &id : declared) {
        const PluginPermissionSpec *spec = find(id);
        if (!spec)
            continue;
        array.append(QJsonObject {
            {QStringLiteral("id"), spec->id},
            {QStringLiteral("label"), spec->label},
            {QStringLiteral("description"), spec->description},
            {QStringLiteral("risk"), spec->risk},
            {QStringLiteral("sensitive"), spec->sensitive},
            {QStringLiteral("granted"), isGranted(granted, spec->id)},
        });
    }
    return array;
}

QString PluginPermissions::requiredForCommand(const QStringList &arguments)
{
    QStringList words;
    for (const QString &argument : arguments) {
        if (argument.startsWith(QLatin1Char('-')))
            break;
        words << argument.trimmed().toLower();
        if (words.size() == 2)
            break;
    }
    if (words.isEmpty())
        return QString();
    const QString prefix = words.join(QLatin1Char(' '));
    for (const PluginPermissionSpec &spec : all()) {
        if (spec.commandPrefixes.contains(prefix))
            return spec.id;
    }
    return QString();
}

} // namespace mcsm
