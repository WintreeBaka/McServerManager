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

    m_layout->insertWidget(qMax(0, m_layout->count() - 1), card);
    m_toasts.append(card);
    while (m_toasts.size() > m_maxVisible) {
        QWidget *oldest = m_toasts.takeFirst();
        m_layout->removeWidget(oldest);
        oldest->deleteLater();
    }

    show();
    raise();
    reposition();

    // The layout owns the position. Animating `pos` here used to leave every card
    // shifted 34px to the right (clipped at the window edge) and made two notices
    // pushed together overlap, which looked like a third notification. Fade in place.
    m_layout->invalidate();
    m_layout->activate();

    auto *group = new QParallelAnimationGroup(card);
    auto *fade = new QPropertyAnimation(effect, "opacity", group);
    fade->setDuration(Easing::normal());
    fade->setEasingCurve(Easing::entrance());
    fade->setStartValue(0.0);
    fade->setEndValue(1.0);

    group->start(QAbstractAnimation::DeleteWhenStopped);

    QTimer::singleShot(qMax(1200, timeoutMs), card, [this, card, effect]() {
        auto *outGroup = new QParallelAnimationGroup(card);
        auto *fadeOut = new QPropertyAnimation(effect, "opacity", outGroup);
        fadeOut->setDuration(Easing::fast());
        fadeOut->setEasingCurve(Easing::standard());
        fadeOut->setStartValue(effect->opacity());
        fadeOut->setEndValue(0.0);

        QObject::connect(outGroup, &QParallelAnimationGroup::finished, this, [this, card]() {
            m_toasts.removeAll(card);
            m_layout->removeWidget(card);
            card->deleteLater();
            // re-place the survivors so the stack stays aligned after a removal
            m_layout->invalidate();
            m_layout->activate();
            if (m_toasts.isEmpty())
                hide();
        });
        outGroup->start(QAbstractAnimation::DeleteWhenStopped);
    });
}

void ToastHost::clearAll()
{
    for (QWidget *toast : m_toasts) {
        m_layout->removeWidget(toast);
        toast->deleteLater();
    }
    m_toasts.clear();
    hide();
}

} // namespace mcsm
