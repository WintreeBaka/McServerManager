# Windows 脚本执行策略

本项目附带的 `scripts\*.ps1` 和 `tools\*.ps1` 是本地构建、测试及发布辅助脚本，不随桌面发行包安装到系统目录。

PowerShell 默认可能阻止未签名的脚本。请按以下方式在当前用户范围内执行，不要为了运行本项目而关闭系统的执行策略：

```powershell
# 仅处理从可信渠道下载后带有 Zone.Identifier 的脚本
Get-ChildItem .\scripts\*.ps1, .\tools\*.ps1 |
    Unblock-File

# 查看当前策略
Get-ExecutionPolicy -List

# 如当前进程被限制，仅为本次终端会话放开
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

更稳妥的方式是在受控终端中只允许签名脚本：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy AllSigned
```

运行任何发布脚本前，请用同目录的 `.sha256` 文件校验压缩包，并确认脚本来源是本仓库。不要使用 `Set-ExecutionPolicy -Scope LocalMachine Unrestricted`；该设置会放宽整台机器的保护范围。
