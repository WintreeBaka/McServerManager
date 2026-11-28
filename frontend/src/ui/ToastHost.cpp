#include "ui/ToastHost.h"

#include <QEvent>
#include <QGraphicsOpacityEffect>
#include <QHBoxLayout>
#include <QLabel>
#include <QParallelAnimationGroup>
#include <QPropertyAnimation>
#include <QTimer>
#include <QVBoxLayout>

#include "app/Easing.h"
#include "app/ThemeManager.h"
#include "widgets/Common.h"

namespace mcsm {

ToastHost::ToastHost(QWidget *parent)
    : QWidget(parent)
{
    setAttribute(Qt::WA_TransparentForMouseEvents, true);
    m_layout = new QVBoxLayout(this);
    m_layout->setContentsMargins(0, 0, 0, 0);
    m_layout->setSpacing(10);
    m_layout->addStretch(1);
    setFixedWidth(320);
    hide();
    // the strip is anchored to the parent's right edge, so it has to follow a resize
    if (QWidget *owner = parentWidget())
        owner->installEventFilter(this);
}

void ToastHost::reposition()
{
    if (!parentWidget())
        return;
    const int margin = 24;
    const int top = 70;
    setGeometry(parentWidget()->width() - width() - margin, top, width(),
                qMax(0, parentWidget()->height() - top - margin));
    raise();
}

void ToastHost::resizeEvent(QResizeEvent *event)
{
    QWidget::resizeEvent(event);
    reposition();
}

bool ToastHost::eventFilter(QObject *watched, QEvent *event)
{
    if (watched == parentWidget() && event->type() == QEvent::Resize) {
        // Without this the strip kept the geometry from before the window was resized,
        // so toasts were anchored past the right edge and got clipped.
        reposition();
        m_layout->invalidate();
        m_layout->activate();
    }
    return QWidget::eventFilter(watched, event);
}

void ToastHost::push(const QString &message, const QString &level, int timeoutMs)
{
    // One user action can reach this through more than one signal (a theme change is
    // both logged and announced), which used to leave an extra card on screen. Collapse
    // identical notices that arrive in the same burst.
    const QDateTime now = QDateTime::currentDateTime();
    if (message == m_lastMessage && level == m_lastLevel && m_lastPush.isValid()
        && m_lastPush.msecsTo(now) < 700) {
        return;
    }
    m_lastMessage = message;
    m_lastLevel = level;
    m_lastPush = now;

    const Palette &palette = ThemeManager::instance()->palette();
    QColor accent = palette.blue;
    QString glyph = QStringLiteral("ℹ");
    if (level == QLatin1String("success")) {
        accent = palette.success;
        glyph = QStringLiteral("✔");
    } else if (level == QLatin1String("warning")) {
        accent = palette.warning;
        glyph = QStringLiteral("!");
    } else if (level == QLatin1String("error")) {
        accent = palette.danger;
        glyph = QStringLiteral("✕");
    } else if (level == QLatin1String("pink")) {
        accent = palette.pink;
    }

    auto *card = new CardFrame(this);
    card->setVariant(CardFrame::Surface);
    card->setRadius(16);
    auto *layout = CardFrame::horizontalLayout(card, 14, 10);

    auto *icon = new QLabel(glyph, card);
    icon->setFixedSize(26, 26);
    icon->setAlignment(Qt::AlignCenter);
    icon->setStyleSheet(QStringLiteral("border-radius: 13px; color: white; background: %1;")
                            .arg(accent.name()));

    auto *text = new QLabel(message, card);
    text->setWordWrap(true);
    // A long CJK notice offers no spaces to break on, so QLabel reports a minimum width
    // wider than this 320px strip and the card was laid out past the window edge with
    // its right side cut off. Ignoring the hint lets the text wrap inside the card.
    text->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Preferred);
    text->setMinimumWidth(0);
    text->setStyleSheet(QStringLiteral("color: %1;").arg(palette.text.name()));

    layout->addWidget(icon, 0, Qt::AlignTop);
    layout->addWidget(text, 1);

    auto *effect = new QGraphicsOpacityEffect(card);
    effect->setOpacity(0.0);
    card->setGraphicsEffect(effect);
    card->setMaximumHeight(0);

    m_layout->insertWidget(qMax(0, m_layout->count() - 1), card);
    m_toasts.append(card);
    while (m_toasts.size() > m_maxVisible) {
        QWidget *oldest = m_toasts.takeFirst();
        dismissToast(oldest);
    }

    show();
    raise();
    reposition();

    // Animate reveal height and opacity together. The layout owns positions, so
    // this keeps the stack aligned while survivors are pushed upward naturally.
    m_layout->invalidate();
    m_layout->activate();

    const int targetHeight = qMax(44, card->sizeHint().height());
    if (!ThemeManager::instance()->animationsEnabled()) {
        card->setMaximumHeight(QWIDGETSIZE_MAX);
        effect->setOpacity(1.0);
    } else {
        auto *group = new QParallelAnimationGroup(card);
        auto *fade = new QPropertyAnimation(effect, "opacity", group);
        fade->setDuration(Easing::normal());
        fade->setEasingCurve(Easing::entrance());
        fade->setStartValue(0.0);
        fade->setEndValue(1.0);
        auto *reveal = new QPropertyAnimation(card, "maximumHeight", group);
        reveal->setDuration(Easing::normal());
        reveal->setEasingCurve(Easing::entrance());
        reveal->setStartValue(0);
        reveal->setEndValue(targetHeight);
        connect(group, &QParallelAnimationGroup::finished, card, [card]() {
            card->setMaximumHeight(QWIDGETSIZE_MAX);
        });
        group->start(QAbstractAnimation::DeleteWhenStopped);
    }

    QTimer::singleShot(qMax(1200, timeoutMs), card,
                       [this, card]() { dismissToast(card); });
}

void ToastHost::dismissToast(QWidget *toast, bool immediate)
{
    if (!toast)
        return;
    m_toasts.removeAll(toast);
    const auto finish = [this, toast]() {
        m_dismissing.remove(toast);
        m_layout->removeWidget(toast);
        toast->deleteLater();
        m_layout->invalidate();
        m_layout->activate();
        if (m_toasts.isEmpty() && m_dismissing.isEmpty())
            hide();
    };

    if (immediate || !ThemeManager::instance()->animationsEnabled()) {
        finish();
        return;
    }
    if (m_dismissing.contains(toast))
        return;
    m_dismissing.insert(toast);

    const qreal startOpacity =
        qobject_cast<QGraphicsOpacityEffect *>(toast->graphicsEffect())
            ? qobject_cast<QGraphicsOpacityEffect *>(toast->graphicsEffect())->opacity()
            : 1.0;
    auto *fadeEffect = qobject_cast<QGraphicsOpacityEffect *>(toast->graphicsEffect());
    auto *group = new QParallelAnimationGroup(toast);
    if (fadeEffect) {
        auto *fade = new QPropertyAnimation(fadeEffect, "opacity", group);
        fade->setDuration(Easing::fast());
        fade->setEasingCurve(Easing::standard());
        fade->setStartValue(startOpacity);
        fade->setEndValue(0.0);
    }
    auto *contract = new QPropertyAnimation(toast, "maximumHeight", group);
    contract->setDuration(Easing::fast());
    contract->setEasingCurve(Easing::standard());
    contract->setStartValue(qMax(0, toast->height()));
    contract->setEndValue(0);
    connect(group, &QParallelAnimationGroup::finished, this, finish);
    group->start(QAbstractAnimation::DeleteWhenStopped);
}

void ToastHost::clearAll()
{
    const QList<QWidget *> cards = findChildren<QWidget *>(QString(), Qt::FindDirectChildrenOnly);
    for (QWidget *toast : cards) {
        m_layout->removeWidget(toast);
        delete toast;
    }
    m_toasts.clear();
    m_dismissing.clear();
    hide();
}

} // namespace mcsm
