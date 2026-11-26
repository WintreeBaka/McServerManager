#pragma once

namespace mcsm::constants {

constexpr int kStorageSyncDelayMs = 150;
constexpr int kEnvironmentRefreshThrottleMs = 4000;
constexpr int kLogFilterDebounceMs = 120;
constexpr int kPluginPageRebuildDebounceMs = 50;

constexpr int kMaxPluginPageBlocks = 200;
constexpr int kMaxPluginTableRows = 500;
constexpr int kMaxPluginTableColumns = 24;
constexpr int kMaxPluginBlockTextChars = 20000;
constexpr int kMaxPluginHtmlChars = 100000;
constexpr int kMaxPluginPendingLogLines = 500;

constexpr int kMaxPendingOutputBytes = 1024 * 1024;
constexpr int kMaxBufferedLines = 2000;
constexpr int kMaxDisplayLineChars = 64 * 1024;

} // namespace mcsm::constants
