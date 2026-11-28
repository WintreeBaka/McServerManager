#pragma once

#include <QJsonObject>
#include <QString>

#include "core/JsonUtil.h"

namespace mcsm {

/// Issues short-lived, target-bound challenges for irreversible operations.
/// The desktop UI and CLI both have to exchange the challenge with the backend;
/// the actual delete command is rejected unless the same process can redeem it.
class ConfirmationService
{
public:
    static Result issue(const QString &action, const QString &target);
    static Result consume(const QString &action,
                          const QString &target,
                          const QString &token,
                          const QString &code);

private:
    static QString confirmationDir();
    static bool validAction(const QString &action);
    static bool validTarget(const QString &target);
    static void pruneExpired();
};

} // namespace mcsm
