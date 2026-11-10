#pragma once

#include <QVector>
#include <QWidget>

class QLabel;
class QToolButton;

namespace mcsm {

/// Custom window chrome: app identity, live status chips and window controls.
class TitleBar : public QWidget
{
    Q_OBJECT

public:
    explicit TitleBar(QWidget *parent = nullptr);

    void setSubtitle(const QString &text);
    void setBackendState(bool available, const QString &detail = QString());
    void setDockerState(const QString &state, const QString &detail = QString());
    void setThemeIsDark(bool dark);
    /// Re-applies the colours this bar bakes into inline stylesheets (logo, window
    /// buttons and the two status chips). Widgets that only carry a `role` property
    /// are restyled by the application stylesheet, but these own their own colours,
    /// so without this they keep the old palette until the next state change.
    void applyTheme();

signals:
    void themeToggleRequested();
    void settingsRequested();
    void notificationsRequested();

protected:
    void paintEvent(QPaintEvent *event) override;
    /// The whole bar drags the frameless window, double click toggles maximize.
    void mousePressEvent(QMouseEvent *event) override;
    void mouseDoubleClickEvent(QMouseEvent *event) override;

private:
    QToolButton *makeControl(const QString &glyph, const QString &tooltip);
    void refreshChips();

    QLabel *m_title = nullptr;
    QLabel *m_subtitle = nullptr;
    QLabel *m_logo = nullptr;
    QLabel *m_backendChip = nullptr;
    QLabel *m_dockerChip = nullptr;
    QToolButton *m_themeButton = nullptr;
    QVector<QToolButton *> m_controls;

    bool m_backendAvailable = false;
    bool m_backendKnown = false;
    QString m_backendDetail;
    QString m_dockerState;
    QString m_dockerDetail;
};

} // namespace mcsm
