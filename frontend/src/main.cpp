#include <QApplication>
#include <QCommandLineParser>
#include <QDir>
#include <QFileInfo>
#include <QFont>
#include <QIcon>
#include <QPainter>
#include <QPixmap>
#include <QStyleFactory>
#include <QTimer>

#include "app/AppContext.h"
#include "ui/MainWindow.h"

namespace {

QPixmap fallbackAppIcon()
{
    QPixmap pixmap(128, 128);
    pixmap.fill(Qt::transparent);
    QPainter painter(&pixmap);
    painter.setRenderHint(QPainter::Antialiasing, true);

    painter.setPen(QPen(QColor(255, 255, 255, 150), 4));
    painter.setBrush(QColor(0xF6, 0xB9, 0xD3));
    painter.drawRoundedRect(QRectF(5, 5, 118, 118), 28, 28);

    QFont font;
    font.setBold(true);
    font.setPixelSize(62);
    painter.setFont(font);
    painter.setPen(QColor(0x3A, 0x30, 0x44));
    painter.drawText(QRectF(5, 0, 118, 120), Qt::AlignCenter, QStringLiteral("M"));
    return pixmap;
}

QIcon applicationIcon()
{
    const QDir appDir(QCoreApplication::applicationDirPath());
    const QStringList candidates = {
        appDir.filePath(QStringLiteral("assets/icon/app.svg")),
        appDir.filePath(QStringLiteral("../../assets/icon/app.svg")),
    };
    for (const QString &path : candidates) {
        if (!QFileInfo::exists(path))
            continue;
        const QIcon icon(path);
        if (!icon.isNull())
            return icon;
    }
    return QIcon(fallbackAppIcon());
}

} // namespace

int main(int argc, char *argv[])
{
    QApplication app(argc, argv);
    QApplication::setApplicationName(QStringLiteral("McServerManager"));
    QApplication::setOrganizationName(QStringLiteral("McServerManager"));
    QApplication::setApplicationVersion(QStringLiteral(MCSM_VERSION));
    QApplication::setWindowIcon(applicationIcon());

    // Draw every control ourselves: the native Windows style ignores parts of
    // the style sheet (combo box popups follow the *system* light/dark theme,
    // which produced black-on-black popups) and varies between Windows versions.
    // Fusion honours both the palette and the style sheet completely, while
    // native file dialogs stay native.
    if (QStyle *fusion = QStyleFactory::create(QStringLiteral("Fusion")))
        QApplication::setStyle(fusion);

    QFont appFont;
    appFont.setFamilies({QStringLiteral("HarmonyOS Sans SC"), QStringLiteral("MiSans"),
                         QStringLiteral("Noto Sans SC"), QStringLiteral("Source Han Sans SC"),
                         QStringLiteral("Microsoft YaHei UI"), QStringLiteral("Segoe UI")});
    appFont.setPointSizeF(10.0);
    QApplication::setFont(appFont);

    mcsm::AppContext *context = mcsm::AppContext::instance();
    context->bootstrap();

    mcsm::MainWindow window;
    window.show();

    // `--page servers` opens a specific page (handy for shortcuts and tests).
    const QStringList arguments = QCoreApplication::arguments();
    const int pageIndex = arguments.indexOf(QStringLiteral("--page"));
    if (pageIndex >= 0 && pageIndex + 1 < arguments.size())
        QTimer::singleShot(0, &window, [&window, arguments, pageIndex]() {
            window.showPage(arguments.at(pageIndex + 1));
        });

    return app.exec();
}
