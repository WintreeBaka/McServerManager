#include "net/HttpClient.h"

#include <QCoreApplication>
#include <QDir>
#include <QEventLoop>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSaveFile>
#include <QTemporaryFile>
#include <QTimer>

#include "core/Logger.h"
#include "core/StringUtil.h"

namespace mcsm {
namespace {

bool isLoopbackHost(const QString &host)
{
    const QString lower = host.toLower();
    return lower == QLatin1String("localhost") || lower == QLatin1String("127.0.0.1")
        || lower == QLatin1String("::1");
}

bool isAllowedHttpUrl(const QUrl &url)
{
    if (!url.isValid() || url.host().isEmpty())
        return false;
    const QString scheme = url.scheme().toLower();
    if (scheme == QLatin1String("https"))
        return true;
    return scheme == QLatin1String("http") && isLoopbackHost(url.host());
}

QString securityError(const QUrl &url)
{
    return QStringLiteral("拒绝非 HTTPS 地址（本机 localhost 除外）：%1").arg(url.toString());
}

} // namespace

QString HttpClient::s_userAgent =
    QStringLiteral("McServerManager/1.0 (+https://localhost) Qt/%1").arg(QLatin1String(qVersion()));

bool HttpReply::parseJson(QJsonObject *out) const
{
    if (!out)
        return false;
    QJsonParseError err {};
    const QJsonDocument doc = QJsonDocument::fromJson(body, &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject())
        return false;
    *out = doc.object();
    return true;
}

void HttpClient::setUserAgent(const QString &userAgent)
{
    if (!userAgent.trimmed().isEmpty())
        s_userAgent = userAgent.trimmed();
}

QString HttpClient::userAgent()
{
    return s_userAgent;
}

HttpReply HttpClient::get(const QUrl &url, int timeoutMs, int maxRedirects, qint64 maxBytes)
{
    HttpReply reply;
    if (!isAllowedHttpUrl(url)) {
        reply.error = url.isValid() ? securityError(url) : QStringLiteral("invalid url");
        return reply;
    }

    QNetworkAccessManager manager;
    QUrl current = url;

    for (int hop = 0; hop <= maxRedirects; ++hop) {
        if (!isAllowedHttpUrl(current)) {
            reply.error = securityError(current);
            return reply;
        }
        QNetworkRequest request(current);
        request.setHeader(QNetworkRequest::UserAgentHeader, s_userAgent);
        request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                             QNetworkRequest::ManualRedirectPolicy);
        request.setTransferTimeout(timeoutMs);

        QNetworkReply *handle = manager.get(request);
        QEventLoop loop;
        QTimer guard;
        QByteArray payload;
        bool tooLarge = false;
        guard.setSingleShot(true);
        QObject::connect(handle, &QNetworkReply::finished, &loop, &QEventLoop::quit);
        QObject::connect(handle, &QNetworkReply::readyRead, &loop, [&]() {
            payload += handle->readAll();
            if (payload.size() > maxBytes) {
                tooLarge = true;
                handle->abort();
                loop.quit();
            }
        });
        QObject::connect(&guard, &QTimer::timeout, &loop, [&loop, handle]() {
            handle->abort();
            loop.quit();
        });
        guard.start(timeoutMs + 2000);
        loop.exec();

        const int status = handle->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const qint64 declared = handle->header(QNetworkRequest::ContentLengthHeader).toLongLong();
        const QVariant location = handle->attribute(QNetworkRequest::RedirectionTargetAttribute);
        payload += handle->readAll();
        const QString contentType = handle->header(QNetworkRequest::ContentTypeHeader).toString();
        const QNetworkReply::NetworkError netError = handle->error();
        const QString netErrorText = handle->errorString();
        handle->deleteLater();

        if (status >= 300 && status < 400 && location.isValid()) {
            current = current.resolved(location.toUrl());
            if (!isAllowedHttpUrl(current)) {
                reply.error = securityError(current);
                return reply;
            }
            Logger::debug(QStringLiteral("http"), QStringLiteral("redirect -> %1").arg(current.toString()));
            continue;
        }
        if (tooLarge || declared > maxBytes || payload.size() > maxBytes) {
            reply.status = status;
            reply.error = QStringLiteral("HTTP 响应超过上限 %1 字节").arg(maxBytes);
            return reply;
        }

        reply.status = status;
        reply.body = payload;
        reply.contentType = contentType;
        reply.ok = (netError == QNetworkReply::NoError) && status >= 200 && status < 300;
        if (!reply.ok) {
            reply.error = netErrorText.isEmpty()
                              ? QStringLiteral("http %1").arg(status)
                              : QStringLiteral("http %1: %2").arg(status).arg(netErrorText);
        }
        return reply;
    }

    reply.error = QStringLiteral("too many redirects");
    return reply;
}

bool HttpClient::download(const QUrl &url,
                          const QString &targetPath,
                          QString *error,
                          const ProgressFn &progress,
                          int timeoutMs,
                          qint64 maxBytes)
{
    auto failWith = [error](const QString &message) {
        if (error)
            *error = message;
        return false;
    };

    if (!isAllowedHttpUrl(url))
        return failWith(url.isValid() ? securityError(url) : QStringLiteral("invalid download url"));

    QDir().mkpath(QFileInfo(targetPath).absolutePath());
    QSaveFile file(targetPath);
    if (!file.open(QIODevice::WriteOnly))
        return failWith(QStringLiteral("cannot open %1").arg(targetPath));

    QNetworkAccessManager manager;
    QUrl current = url;
    const int maxRedirects = 8;

    for (int hop = 0; hop <= maxRedirects; ++hop) {
        if (!isAllowedHttpUrl(current)) {
            file.cancelWriting();
            return failWith(securityError(current));
        }
        QNetworkRequest request(current);
        request.setHeader(QNetworkRequest::UserAgentHeader, s_userAgent);
        request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                             QNetworkRequest::ManualRedirectPolicy);
        request.setTransferTimeout(timeoutMs);

        QNetworkReply *handle = manager.get(request);
        QEventLoop loop;
        QTimer guard;
        qint64 hopBytes = 0;
        bool tooLarge = false;
        // Buffer one hop in a temp file: a redirect body is discarded, and a
        // 2xx body is copied into the target only after the hop completes.
        QTemporaryFile hopFile;
        if (!hopFile.open()) {
            handle->abort();
            handle->deleteLater();
            file.cancelWriting();
            return failWith(QStringLiteral("cannot create temporary download file"));
        }
        guard.setSingleShot(true);
        QObject::connect(handle, &QNetworkReply::finished, &loop, &QEventLoop::quit);
        QObject::connect(handle, &QNetworkReply::readyRead, &loop, [&]() {
            const QByteArray chunk = handle->readAll();
            hopBytes += chunk.size();
            if (!chunk.isEmpty())
                hopFile.write(chunk);
            if (hopBytes > maxBytes) {
                tooLarge = true;
                handle->abort();
                loop.quit();
            }
        });
        QObject::connect(handle, &QNetworkReply::downloadProgress, &loop,
                         [&progress](qint64 got, qint64 total) {
                             if (progress)
                                 progress(got, total);
                         });
        QObject::connect(&guard, &QTimer::timeout, &loop, [&loop, handle]() {
            handle->abort();
            loop.quit();
        });
        guard.start(timeoutMs);
        loop.exec();

        const int status = handle->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const qint64 declared = handle->header(QNetworkRequest::ContentLengthHeader).toLongLong();
        const QByteArray rest = handle->readAll();
        hopBytes += rest.size();
        if (!rest.isEmpty())
            hopFile.write(rest);
        const QVariant location = handle->attribute(QNetworkRequest::RedirectionTargetAttribute);
        const QString netErrorText = handle->errorString();
        const QNetworkReply::NetworkError netError = handle->error();
        handle->deleteLater();

        if (status >= 300 && status < 400 && location.isValid()) {
            current = current.resolved(location.toUrl());
            if (!isAllowedHttpUrl(current)) {
                file.cancelWriting();
                return failWith(securityError(current));
            }
            continue;
        }
        if (tooLarge || declared > maxBytes || hopBytes > maxBytes) {
            file.cancelWriting();
            return failWith(QStringLiteral("下载内容超过上限 %1 字节").arg(maxBytes));
        }
        if (netError != QNetworkReply::NoError || status < 200 || status >= 300) {
            file.cancelWriting();
            return failWith(netErrorText.isEmpty()
                                ? QStringLiteral("download failed with http %1").arg(status)
                                : QStringLiteral("download failed: %1").arg(netErrorText));
        }

        hopFile.flush();
        hopFile.seek(0);
        while (!hopFile.atEnd()) {
            const QByteArray chunk = hopFile.read(256 * 1024);
            if (chunk.isEmpty() || file.write(chunk) != chunk.size()) {
                file.cancelWriting();
                return failWith(QStringLiteral("cannot write %1").arg(targetPath));
            }
        }

        if (!file.commit())
            return failWith(QStringLiteral("cannot write %1").arg(targetPath));
        Logger::info(QStringLiteral("http"),
                     QStringLiteral("downloaded %1").arg(QFileInfo(targetPath).fileName()));
        return true;
    }

    file.cancelWriting();
    return failWith(QStringLiteral("too many redirects while downloading"));
}

} // namespace mcsm
