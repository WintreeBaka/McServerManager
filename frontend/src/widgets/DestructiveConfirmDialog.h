#pragma once

#include <QDialog>

class QCheckBox;
class QLabel;
class QLineEdit;

namespace mcsm {

class GradientButton;

/// Two-factor deletion prompt used by every destructive UI action. The code is
/// generated and later consumed by the backend; the dialog only displays it.
class DestructiveConfirmDialog : public QDialog
{
    Q_OBJECT

public:
    DestructiveConfirmDialog(const QString &action, const QString &target,
                             const QString &title, const QString &description,
                             const QString &optionText = QString(),
                             bool optionChecked = false, bool optionRequired = false,
                             QWidget *parent = nullptr);

    QString confirmationToken() const { return m_token; }
    QString confirmationCode() const { return m_code; }
    bool optionChecked() const;

private:
    void requestChallenge();
    void updateConfirmState();

    QString m_action;
    QString m_target;
    QString m_token;
    QString m_code;
    QLabel *m_codeLabel = nullptr;
    QLabel *m_statusLabel = nullptr;
    QLineEdit *m_codeEdit = nullptr;
    QCheckBox *m_option = nullptr;
    GradientButton *m_confirm = nullptr;
    bool m_optionRequired = false;
};

} // namespace mcsm
