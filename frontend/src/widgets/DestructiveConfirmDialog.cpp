#include "widgets/DestructiveConfirmDialog.h"

#include <QCheckBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QRegularExpressionValidator>
#include <QPushButton>
#include <QVBoxLayout>

#include "app/AppContext.h"
#include "app/ThemeManager.h"
#include "widgets/Common.h"

namespace mcsm {

DestructiveConfirmDialog::DestructiveConfirmDialog(const QString &action,
                                                   const QString &target,
                                                   const QString &title,
                                                   const QString &description,
                                                   const QString &optionText,
                                                   bool optionChecked,
                                                   bool optionRequired,
                                                   QWidget *parent)
    : QDialog(parent), m_action(action), m_target(target),
      m_optionRequired(optionRequired)
{
    setWindowTitle(title);
    setModal(true);
    setMinimumWidth(520);
    setAttribute(Qt::WA_StyledBackground, true);
    setAutoFillBackground(true);
    AppContext::applyDialogSurface(this);

    auto *layout = new QVBoxLayout(this);
    layout->setContentsMargins(24, 22, 24, 20);
    layout->setSpacing(14);

    auto *heading = makeLabel(title, QStringLiteral("title"), this);
    layout->addWidget(heading);

    auto *warning = new CardFrame(this);
    warning->setVariant(CardFrame::Alt);
    auto *warningLayout = new QVBoxLayout(warning);
    warningLayout->setContentsMargins(14, 12, 14, 12);
    warningLayout->setSpacing(5);
    auto *warningTitle =
        makeLabel(QStringLiteral("此操作不可回滚"), QStringLiteral("subtitle"), warning);
    warningTitle->setStyleSheet(
        QStringLiteral("color: %1;").arg(ThemeManager::instance()->palette().danger.name()));
    warningLayout->addWidget(warningTitle);
    auto *warningText = makeLabel(description, QStringLiteral("hint"), warning);
    warningText->setWordWrap(true);
    warningLayout->addWidget(warningText);
    layout->addWidget(warning);

    layout->addWidget(makeLabel(QStringLiteral("后端确认码"), QStringLiteral("caption"), this));
    m_codeLabel = makeLabel(QStringLiteral("正在生成…"), QStringLiteral("title"), this);
    m_codeLabel->setTextInteractionFlags(Qt::TextSelectableByMouse);
    m_codeLabel->setAlignment(Qt::AlignCenter);
    m_codeLabel->setMinimumHeight(48);
    m_codeLabel->setStyleSheet(
        QStringLiteral("font-family: Consolas, monospace; font-size: 25px; letter-spacing: 7px;"
                       " color: %1;")
            .arg(ThemeManager::instance()->palette().blue.name()));
    layout->addWidget(m_codeLabel);

    layout->addWidget(
        makeLabel(QStringLiteral("请输入上方完整相同的 8 位数字"), QStringLiteral("hint"), this));
    m_codeEdit = new QLineEdit(this);
    m_codeEdit->setMaxLength(8);
    m_codeEdit->setPlaceholderText(QStringLiteral("8 位数字确认码"));
    m_codeEdit->setValidator(
        new QRegularExpressionValidator(QRegularExpression(QStringLiteral("\\d{0,8}")), this));
    m_codeEdit->setEnabled(false);
    layout->addWidget(m_codeEdit);

    if (!optionText.isEmpty()) {
        m_option = new QCheckBox(optionText, this);
        m_option->setChecked(optionChecked);
        layout->addWidget(m_option);
    }

    m_statusLabel =
        makeLabel(QStringLiteral("正在请求后端确认码…"), QStringLiteral("hint"), this);
    m_statusLabel->setWordWrap(true);
    layout->addWidget(m_statusLabel);

    auto *buttons = new QHBoxLayout();
    buttons->addStretch(1);
    auto *cancel = new GradientButton(QStringLiteral("取消"), this);
    cancel->setStyle(GradientButton::Outline);
    m_confirm = new GradientButton(QStringLiteral("确认删除"), this);
    m_confirm->setStyle(GradientButton::Danger);
    m_confirm->setEnabled(false);
    buttons->addWidget(cancel);
    buttons->addWidget(m_confirm);
    layout->addLayout(buttons);

    connect(cancel, &QPushButton::clicked, this, &QDialog::reject);
    connect(m_confirm, &QPushButton::clicked, this, &QDialog::accept);
    connect(m_codeEdit, &QLineEdit::textChanged, this,
            [this](const QString &) { updateConfirmState(); });
    if (m_option) {
        connect(m_option, &QCheckBox::toggled, this,
                [this](bool) { updateConfirmState(); });
    }
    requestChallenge();
}

bool DestructiveConfirmDialog::optionChecked() const
{
    return m_option && m_option->isChecked();
}

void DestructiveConfirmDialog::requestChallenge()
{
    AppContext::instance()->backend()->request(
        {QStringLiteral("confirm"), QStringLiteral("issue"), QStringLiteral("--action"),
         m_action, QStringLiteral("--target"), m_target},
        this, [this](const Reply &reply) {
            if (!reply.ok) {
                m_codeLabel->setText(QStringLiteral("—"));
                m_statusLabel->setText(
                    QStringLiteral("无法生成确认码：%1").arg(reply.errorText()));
                return;
            }
            m_token = reply.data.value(QStringLiteral("token")).toString();
            m_code = reply.data.value(QStringLiteral("code")).toString();
            if (m_token.isEmpty() || m_code.size() != 8) {
                m_codeLabel->setText(QStringLiteral("—"));
                m_statusLabel->setText(QStringLiteral("后端返回的确认码无效，已拒绝删除。"));
                return;
            }
            m_codeLabel->setText(m_code);
            m_codeEdit->setEnabled(true);
            m_codeEdit->setFocus();
            m_statusLabel->setText(
                QStringLiteral("确认码由后端生成，仅可使用一次并在数分钟后失效。"));
            updateConfirmState();
        });
}

void DestructiveConfirmDialog::updateConfirmState()
{
    const bool codeMatches = !m_code.isEmpty() && m_codeEdit->text() == m_code;
    const bool optionReady = !m_optionRequired || optionChecked();
    m_confirm->setEnabled(codeMatches && optionReady && !m_token.isEmpty());
}

} // namespace mcsm
