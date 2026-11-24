#include "pages/PluginPageView.h"

#include <QDateTime>
#include <QCheckBox>
#include <QDesktopServices>
#include <QFileDialog>
#include <QFont>
#include <QGridLayout>
#include <QHeaderView>
#include <QHBoxLayout>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLabel>
#include <QProcess>
#include <QProgressBar>
#include <QPushButton>
#include <QScrollArea>
#include <QScrollBar>
#include <QStyledItemDelegate>
#include <QTableWidget>
#include <QTimer>
#include <QUrl>
#include <QVBoxLayout>

#include "app/AppContext.h"
#include "widgets/Chip.h"
#include "widgets/LogView.h"

namespace mcsm {
namespace {

void clearLayout(QLayout *layout)
{
    if (!layout)
        return;
    while (QLayoutItem *item = layout->takeAt(0)) {
        if (QWidget *widget = item->widget()) {
            // hide first: a deferred delete would otherwise flash the old block
            // on top of the rebuilt one for one frame.
            widget->hide();
            widget->deleteLater();
        }
        if (QLayout *child = item->layout())
            clearLayout(child);
        delete item;
    }
}

QString blockStyle(const QJsonObject &block, const QString &fallback)
{
    const QString style = block.value(QStringLiteral("style")).toString().toLower();
    if (style == QLatin1String("hint") || style == QLatin1String("caption")
        || style == QLatin1String("subtitle") || style == QLatin1String("title"))
        return style;
    return fallback;
}

/// QSS `::item { padding-left }` also insets cell *widgets*, which pushed the
/// checkbox 10px right of the column edge, so the text padding is drawn by a
/// delegate instead and the widget lands flush with the column.
class PaddedDelegate : public QStyledItemDelegate
{
public:
    explicit PaddedDelegate(int horizontal, QObject *parent = nullptr)
        : QStyledItemDelegate(parent)
        , pad_(horizontal)
    {
    }

    void paint(QPainter *painter, const QStyleOptionViewItem &option,
               const QModelIndex &index) const override
    {
        QStyleOptionViewItem adjusted = option;
        adjusted.rect = option.rect.adjusted(pad_, 0, -pad_, 0);
        QStyledItemDelegate::paint(painter, adjusted, index);
    }

private:
    int pad_;
};

/// Runs the native dialog a button asked for: {mode: save|open|dir|auto, ...}.
/// `auto` means "save when exactly one row is ticked, otherwise pick a folder",
/// which is what "export the selected servers" needs.
QString pickPath(const QJsonObject &pick, QWidget *parent, int selectedRows)
{
    QString mode = pick.value(QStringLiteral("mode")).toString(QStringLiteral("open")).toLower();
    if (mode == QLatin1String("auto"))
        mode = selectedRows == 1 ? QStringLiteral("save") : QStringLiteral("dir");
    const QString title = pick.value(QStringLiteral("title")).toString(QStringLiteral("选择文件"));
    const QString filter = pick.value(QStringLiteral("filter")).toString(QStringLiteral("所有文件 (*.*)"));
    QString start = pick.value(QStringLiteral("defaultPath")).toString();
    const QString defaultName = pick.value(QStringLiteral("defaultName")).toString();
    if (mode == QLatin1String("save") && !defaultName.isEmpty()) {
        if (start.isEmpty())
            start = defaultName;
        else if (start.endsWith(QLatin1Char('/')) || start.endsWith(QLatin1Char('\\')))
            start += defaultName;
        else
            start += QLatin1Char('/') + defaultName;
    }
    if (mode == QLatin1String("save"))
        return QFileDialog::getSaveFileName(parent, title, start, filter);
    if (mode == QLatin1String("dir") || mode == QLatin1String("folder"))
        return QFileDialog::getExistingDirectory(parent, title, start,
                                                 QFileDialog::ShowDirsOnly
                                                     | QFileDialog::DontResolveSymlinks);
    return QFileDialog::getOpenFileName(parent, title, start, filter);
}

} // namespace

PluginPageView::PluginPageView(const PluginPageInfo &info, QWidget *parent)
    : PageBase(info.title, info.subtitle.isEmpty()
                                ? QStringLiteral("由插件 %1 提供").arg(info.pluginName)
                                : info.subtitle,
               parent)
    , m_info(info)
{
    auto *badge = new Chip(QStringLiteral("%1 %2").arg(info.icon, info.pluginName), this);
    badge->setTone(Chip::Gradient);
    badge->setCompact(true);
    setHeaderTrailing(badge);

    m_container = new QWidget(this);
    m_layout = new QVBoxLayout(m_container);
    m_layout->setContentsMargins(0, 0, 0, 0);
    m_layout->setSpacing(14);
    m_layout->addStretch(1);
    body()->addWidget(m_container, 1);
}

void PluginPageView::setBlocks(const QJsonArray &blocks)
{
    m_blocks = blocks;
    rebuild();
}

void PluginPageView::rebuild()
{
    if (!m_layout)
        return;
    // Rebuilding swaps every widget: without this the page jumps back to the
    // top (or scrolls to a stale focused row) whenever the script redraws.
    QScrollBar *scrollBar = nullptr;
    int scrolled = 0;
    if (QScrollArea *area = scrollArea()) {
        scrollBar = area->verticalScrollBar();
        scrolled = scrollBar->value();
    }
    clearLayout(m_layout);
    m_log = nullptr;
    m_selection.clear();

    if (m_blocks.isEmpty()) {
        auto *empty = new CardFrame(m_container);
        auto *layout = CardFrame::verticalLayout(empty, 20, 8);
        layout->addWidget(makeSectionHeader(QStringLiteral("插件暂未提供内容"), QString(),
                                           nullptr, empty));
        layout->addWidget(makeLabel(QStringLiteral("插件脚本可以用 mcsm.ui.setPageContent() 随时更新这个页面。"),
                                    QStringLiteral("hint"), empty));
        m_layout->addWidget(empty);
    }

    for (const QJsonValue &value : m_blocks) {
        QWidget *widget = buildBlock(value.toObject());
        if (widget)
            m_layout->addWidget(widget);
    }
    m_layout->addStretch(1);

    for (const QString &line : m_pendingLog)
        appendLog(line);
    m_pendingLog.clear();

    if (scrollBar) {
        scrollBar->setValue(scrolled);
        QTimer::singleShot(0, this, [scrollBar, scrolled] {
            scrollBar->setValue(scrolled);
        });
    }
}

QWidget *PluginPageView::buildBlock(const QJsonObject &block)
{
    const QString type = block.value(QStringLiteral("type")).toString().toLower();

    if (type == QLatin1String("divider")) {
        auto *divider = new QFrame(m_container);
        divider->setProperty("role", "divider");
        divider->setFixedHeight(1);
        return divider;
    }

    if (type == QLatin1String("heading")) {
        auto *label = makeLabel(block.value(QStringLiteral("text")).toString(),
                                QStringLiteral("subtitle"), m_container);
        label->setWordWrap(true);
        QFont font = label->font();
        font.setPointSizeF(font.pointSizeF() + 2.0);
        font.setBold(true);
        label->setFont(font);
        return label;
    }

    if (type == QLatin1String("text")) {
        auto *label = makeLabel(block.value(QStringLiteral("text")).toString(),
                                blockStyle(block, QStringLiteral("caption")), m_container);
        label->setWordWrap(true);
        return label;
    }

    if (type == QLatin1String("html")) {
        auto *label = new QLabel(block.value(QStringLiteral("html")).toString(), m_container);
        label->setTextFormat(Qt::RichText);
        label->setWordWrap(true);
        label->setOpenExternalLinks(false);
        connect(label, &QLabel::linkActivated, this, [](const QString &url) { safeOpenUrl(url); });
        label->setProperty("role", QStringLiteral("caption"));
        return label;
    }

    if (type == QLatin1String("keyvalue")) {
        auto *card = new CardFrame(m_container);
        auto *grid = new QGridLayout(card);
        grid->setContentsMargins(20, 16, 20, 16);
        grid->setHorizontalSpacing(24);
        grid->setVerticalSpacing(8);
        int row = 0;
        const QJsonArray items = block.value(QStringLiteral("items")).toArray();
        for (const QJsonValue &value : items) {
            QString key;
            QString text;
            if (value.isArray()) {
                const QJsonArray pair = value.toArray();
                key = pair.at(0).toString();
                text = pair.size() > 1 ? pair.at(1).toString() : QString();
            } else {
                const QJsonObject entry = value.toObject();
                key = entry.value(QStringLiteral("key")).toString();
                text = entry.value(QStringLiteral("value")).toString();
            }
            grid->addWidget(makeLabel(key, QStringLiteral("caption"), card), row, 0);
            auto *valueLabel = makeLabel(text, QStringLiteral("subtitle"), card);
            valueLabel->setTextInteractionFlags(Qt::TextSelectableByMouse);
            grid->addWidget(valueLabel, row, 1);
            ++row;
        }
        grid->setColumnStretch(1, 1);
        return card;
    }

    if (type == QLatin1String("table")) {
        // selectable: one checkbox column in front of the data columns. The
        // selection is pushed to the plugin (event "ui.selection") so the page
        // can react - export commands need to know which servers are ticked.
        const bool selectable = block.value(QStringLiteral("selectable")).toBool();
        const QString selectionKey = block.value(QStringLiteral("key")).toString(QStringLiteral("default"));
        auto *card = new CardFrame(m_container);
        auto *layout = CardFrame::verticalLayout(card, 18, 10);
        if (selectable) {
            // The tick column hugs the card edge, so the table is outdented by
            // 14px; the header row re-adds that inset in its own margins so the
            // card title still lines up with the neighbouring cards.
            layout->setContentsMargins(14, 18, 18, 18);
        }
        const QString title = block.value(QStringLiteral("title")).toString();
        const QJsonArray columns = block.value(QStringLiteral("columns")).toArray();
        const QJsonArray rows = block.value(QStringLiteral("rows")).toArray();

        auto *head = new QWidget(card);
        auto *headLayout = new QHBoxLayout(head);
        headLayout->setContentsMargins(selectable ? 4 : 0, 0, 0, 0);
        headLayout->setSpacing(8);
        if (!title.isEmpty())
            headLayout->addWidget(makeSectionHeader(title, QString(), nullptr, head));
        headLayout->addStretch(1);
        QLabel *selectionLabel = nullptr;
        if (selectable) {
            selectionLabel = makeLabel(QString(), QStringLiteral("hint"), head);
            headLayout->addWidget(selectionLabel);
            auto *allButton = new GradientButton(QStringLiteral("全选"), head);
            allButton->setCompact(true);
            allButton->setStyle(GradientButton::Outline);
            auto *noneButton = new GradientButton(QStringLiteral("全不选"), head);
            noneButton->setCompact(true);
            noneButton->setStyle(GradientButton::Outline);
            headLayout->addWidget(allButton);
            headLayout->addWidget(noneButton);
            QObject::connect(allButton, &QPushButton::clicked, this, [this, card]() {
                for (QCheckBox *box : card->findChildren<QCheckBox *>())
                    box->setChecked(true);
            });
            QObject::connect(noneButton, &QPushButton::clicked, this, [card]() {
                for (QCheckBox *box : card->findChildren<QCheckBox *>())
                    box->setChecked(false);
            });
        }
        if (headLayout->count() > 1)
            layout->addWidget(head);

        auto *table = new QTableWidget(card);
        table->setColumnCount(columns.size() + (selectable ? 1 : 0));
        table->setRowCount(rows.size());
        QStringList header;
        if (selectable)
            header << QString();
        for (const QJsonValue &column : columns)
            header << column.toString();
        table->setHorizontalHeaderLabels(header);
        table->verticalHeader()->setVisible(false);
        table->setFrameShape(QFrame::NoFrame);
        table->setShowGrid(false);
        table->setSelectionMode(QAbstractItemView::NoSelection);
        table->setEditTriggers(QAbstractItemView::NoEditTriggers);
        table->setWordWrap(false);
        table->horizontalHeader()->setSectionResizeMode(QHeaderView::Stretch);
        // Headers used to be centred while cells were left aligned, which read as
        // "the header does not line up with the columns".
        table->horizontalHeader()->setDefaultAlignment(Qt::AlignLeft | Qt::AlignVCenter);
        table->horizontalHeader()->setHighlightSections(false);
        if (selectable) {
            // Fixed checkbox column. Order matters: setColumnWidth() before the
            // resize-mode change is ignored, and the header clamps sections to
            // minimumSectionSize(), which used to squeeze the cell widget and clip
            // the indicator mid-draw.
            table->horizontalHeader()->setMinimumSectionSize(44);
            table->horizontalHeader()->setSectionResizeMode(0, QHeaderView::Fixed);
            table->setColumnWidth(0, 56);
            table->verticalHeader()->setDefaultSectionSize(34);
        }        // Text padding is drawn by the delegate; a QSS `::item` padding would
        // also push the checkbox cell widget away from the column edge.
        table->setItemDelegate(new PaddedDelegate(10, table));
        table->setStyleSheet(QStringLiteral(
            "QTableWidget { background: transparent; border: none; }"));
        table->horizontalHeader()->setStyleSheet(
            QStringLiteral("QHeaderView::section { padding-left: 10px; padding-right: 10px;"
                           " background: transparent; border: none; }"));

        const QJsonArray rowIds = block.value(QStringLiteral("rowIds")).toArray();        QJsonArray preselected = block.value(QStringLiteral("selected")).toArray();
        if (!m_selection.contains(selectionKey)) {
            QStringList initial;
            for (const QJsonValue &value : preselected)
                initial << value.toString();
            m_selection.insert(selectionKey, initial);
        }
        QStringList &selection = m_selection[selectionKey];
        auto publishSelection = [this, selectionKey]() {
            const QStringList ids = m_selection.value(selectionKey);
            QJsonObject payload;
            payload.insert(QStringLiteral("pageId"), m_info.id);
            payload.insert(QStringLiteral("key"), selectionKey);
            payload.insert(QStringLiteral("selected"), QJsonArray::fromStringList(ids));
            payload.insert(QStringLiteral("count"), ids.size());
            PluginHost *host = AppContext::instance()->plugins();
            if (!host)
                return;
            // Queued: a handler may call setPageContent, which rebuilds (and
            // destroys) the very checkbox whose signal is still running.
            QMetaObject::invokeMethod(host, [host, payload]() {
                host->dispatchEvent(QStringLiteral("ui.selection"), payload);
            }, Qt::QueuedConnection);
        };
        if (selectionLabel)
            selectionLabel->setText(QStringLiteral("已选 %1 台").arg(selection.size()));

        for (int row = 0; row < rows.size(); ++row) {
            const QJsonArray cells = rows.at(row).toArray();
            QString rowId = rowIds.size() > row ? rowIds.at(row).toString() : QString();
            if (rowId.isEmpty())
                rowId = cells.isEmpty() ? QString::number(row) : cells.at(0).toString();
            int columnOffset = 0;
            if (selectable) {
                auto *holder = new QWidget(table);
                auto *holderLayout = new QHBoxLayout(holder);
                // Zero insets: the checkbox has to sit on the card's left text
                // column, and QSS item padding would otherwise push it right.
                holderLayout->setContentsMargins(9, 0, 0, 0);
                holderLayout->setSpacing(0);
                auto *box = new QCheckBox(holder);
                box->setFixedSize(20, 20);
                box->setChecked(selection.contains(rowId));
                box->setProperty("rowId", rowId);
                holderLayout->addWidget(box, 0, Qt::AlignLeft | Qt::AlignVCenter);
                holderLayout->addStretch(1);
                table->setCellWidget(row, 0, holder);
                QObject::connect(box, &QCheckBox::toggled, this,
                                 [this, selectionKey, selectionLabel, publishSelection](bool checked) {
                                     auto *box = qobject_cast<QCheckBox *>(sender());
                                     if (!box)
                                         return;
                                     const QString id = box->property("rowId").toString();
                                     QStringList &ids = m_selection[selectionKey];
                                     if (checked) {
                                         if (!ids.contains(id))
                                             ids.append(id);
                                     } else {
                                         ids.removeAll(id);
                                     }
                                     if (selectionLabel)
                                         selectionLabel->setText(
                                             QStringLiteral("已选 %1 台").arg(ids.size()));
                                     publishSelection();
                                 });
                columnOffset = 1;
            }
            for (int column = 0; column < columns.size(); ++column) {
                const QString text = column < cells.size() ? cells.at(column).toString() : QString();
                auto *item = new QTableWidgetItem(text);
                item->setTextAlignment(Qt::AlignLeft | Qt::AlignVCenter);
                item->setFlags(Qt::ItemIsEnabled);
                table->setItem(row, column + columnOffset, item);
            }
        }
        const int height = qMin(60 + rows.size() * 34, 380);
        table->setMinimumHeight(height);
        layout->addWidget(table);

        return card;
    }

    if (type == QLatin1String("buttons")) {
        auto *row = new QWidget(m_container);
        auto *layout = new QHBoxLayout(row);
        layout->setContentsMargins(0, 0, 0, 0);
        layout->setSpacing(10);
        const QJsonArray items = block.value(QStringLiteral("items")).toArray();
        for (const QJsonValue &value : items) {
            const QJsonObject item = value.toObject();
            const QString label = item.value(QStringLiteral("label")).toString();
            if (label.isEmpty())
                continue;
            auto *button = new GradientButton(label, row);
            button->setCompact(true);
            const QString glyph = item.value(QStringLiteral("icon")).toString();
            if (!glyph.isEmpty())
                button->setGlyph(glyph);
            const QString command = item.value(QStringLiteral("command")).toString();
            const QString url = item.value(QStringLiteral("url")).toString();
            const QString toast = item.value(QStringLiteral("toast")).toString();
            const QString openUrlField = item.value(QStringLiteral("openUrlFrom")).toString();
            const QString action = item.value(QStringLiteral("action")).toString();
            // pick: {mode: save|open|dir, title, filter, defaultPath}. The dialog
            // runs here (native, modal) and only the chosen path reaches the
            // script - a plugin never blocks inside a JS callback.
            const QJsonObject pick = item.value(QStringLiteral("pick")).toObject();
            // level: primary (default) / outline (ghost) / soft / danger.
            // The old hard-coded Soft was nearly transparent in dark mode, so
            // plugin buttons looked disabled and authors had no way to fix it.
            const QString tone = item.value(QStringLiteral("level")).toString().trimmed().toLower();
            if (tone == QLatin1String("danger"))
                button->setStyle(GradientButton::Danger);
            else if (tone == QLatin1String("soft"))
                button->setStyle(GradientButton::Soft);
            else if (tone == QLatin1String("outline") || tone == QLatin1String("ghost"))
                button->setStyle(GradientButton::Outline);
            else
                button->setStyle(GradientButton::Primary);
            connect(button, &QPushButton::clicked, this,
                    [this, command, url, toast, openUrlField, action, pick]() {
                        if (!action.isEmpty()) {
                            // Script-backed button: the plugin decides what to do
                            // (ask for a path, then start the export).
                            PluginHost *host = AppContext::instance()->plugins();
                            if (!host) {
                                appendLog(QStringLiteral("! 插件宿主未就绪"));
                                return;
                            }
                            QJsonObject payload;
                            if (!pick.isEmpty()) {
                                int selectedRows = 0;
                                for (auto it = m_selection.constBegin(); it != m_selection.constEnd(); ++it)
                                    selectedRows += it.value().size();
                                const QString path = pickPath(pick, this, selectedRows);
                                if (path.isEmpty()) {
                                    appendLog(QStringLiteral("已取消：没有选择路径"));
                                    return;
                                }
                                payload.insert(QStringLiteral("path"), path);
                            }
                            if (!host->invokeAction(m_info.id, action, payload))
                                appendLog(QStringLiteral("! 插件没有注册动作 %1").arg(action));
                            return;
                        }
                        if (!url.isEmpty()) {
                            safeOpenUrl(url);
                            return;
                        }
                        if (!command.isEmpty())
                            runCommand(command, toast, openUrlField);
                    });
            layout->addWidget(button);
        }
        layout->addStretch(1);
        return row;
    }

    if (type == QLatin1String("log")) {
        auto *card = new CardFrame(m_container);
        auto *layout = CardFrame::verticalLayout(card, 16, 8);
        layout->addWidget(makeSectionHeader(
            block.value(QStringLiteral("title")).toString(QStringLiteral("输出")), QString(), nullptr, card));
        m_log = new LogView(card);
        m_log->setMinimumHeight(140);
        m_log->setFollowOutput(true);
        m_log->setLogLines(QStringList());
        layout->addWidget(m_log, 1);
        const QString text = block.value(QStringLiteral("text")).toString();
        if (!text.isEmpty())
            m_log->appendLines(text.split(QLatin1Char('\n'), Qt::SkipEmptyParts));
        return card;
    }

    if (type == QLatin1String("progress")) {
        auto *row = new QWidget(m_container);
        auto *layout = new QVBoxLayout(row);
        layout->setContentsMargins(0, 0, 0, 0);
        layout->setSpacing(6);
        const QString label = block.value(QStringLiteral("label")).toString();
        if (!label.isEmpty())
            layout->addWidget(makeLabel(label, QStringLiteral("caption"), row));
        auto *bar = new QProgressBar(row);
        bar->setRange(0, 100);
        bar->setValue(qBound(0, block.value(QStringLiteral("value")).toInt(), 100));
        bar->setTextVisible(false);
        layout->addWidget(bar);
        return row;
    }

    // unknown block: show the raw payload so plugin authors can debug quickly
    auto *label = makeLabel(QStringLiteral("[未知区块 %1] %2")
                                .arg(type, QString::fromUtf8(QJsonDocument(block).toJson(QJsonDocument::Compact))),
                            QStringLiteral("hint"), m_container);
    label->setWordWrap(true);
    return label;
}

void PluginPageView::runCommand(const QString &command, const QString &toast,
                                const QString &openUrlField)
{
    appendLog(QStringLiteral("> %1").arg(command));
    const QStringList arguments = QProcess::splitCommand(command);
    AppContext::instance()->backend()->request(
        arguments, this, [this, command, toast, openUrlField](const Reply &reply) {
            if (!reply.ok) {
                appendLog(QStringLiteral("! %1").arg(reply.errorText()));
                AppContext::instance()->logActivity(
                    QStringLiteral("插件命令失败：%1").arg(reply.errorText()), QStringLiteral("error"));
                return;
            }
            const QString summary = QJsonDocument(reply.data).toJson(QJsonDocument::Compact);
            appendLog(QStringLiteral("✔ %1").arg(summary.left(2000)));
            if (!toast.isEmpty())
                AppContext::instance()->logActivity(toast, QStringLiteral("info"));
            if (!openUrlField.isEmpty()) {
                const QString url = reply.data.value(openUrlField).toString();
                if (!url.isEmpty())
                    safeOpenUrl(url);
            }
        });
}

void PluginPageView::appendLog(const QString &line)
{
    if (!m_log) {
        m_pendingLog << line;
        return;
    }
    m_log->appendLine(QStringLiteral("%1  %2")
                          .arg(QDateTime::currentDateTime().toString(QStringLiteral("HH:mm:ss")), line));
}

} // namespace mcsm
