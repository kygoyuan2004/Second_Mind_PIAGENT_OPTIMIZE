# Second Mind Pi v0.3.0

Second Mind Pi can run alongside the Claude SDK edition. Both editions support local knowledge Q&A. Pi also accepts OpenAI Chat Completions connections, runs up to six read-only tools in parallel within a model turn, tracks which note lines it has read and verifies quotations against the source line.

| System | Installer |
| --- | --- |
| Windows 10/11 x64 | `SecondMindPi-0.3.0-windows-x64-setup.exe` |
| Linux x64 | `SecondMindPi-0.3.0-linux-x86_64.AppImage` or `SecondMindPi-0.3.0-linux-amd64.deb` |
| macOS 14+ on Apple Silicon | `SecondMindPi-0.3.0-macos-arm64.dmg` |
| macOS 14+ on Intel | `SecondMindPi-0.3.0-macos-x64.dmg` |
| Docker on amd64 and arm64 | `ghcr.io/kygoyuan2004/second_mind_piagent_optimize:v0.3.0` |

Compare the SHA-256 of your download against the matching entry in `SHA256SUMS.txt`. Windows builds are unsigned. Apple disk images are open-source ad-hoc signed builds distributed without Apple notarization. [首次打开 macOS 安装包 / First launch on macOS](macos-desktop.md)

Pi 桌面设置保存在独立的 `SecondMindPi` 目录。Pi Docker 的默认本机端口为 `8788`，Claude 版为 `8787`。两版选择同一个 Obsidian Vault 时，请依次执行写入任务。

The Pi app, settings and Docker volumes have independent identities. If you select the same Obsidian Vault in both editions, run writing tasks one edition at a time.
