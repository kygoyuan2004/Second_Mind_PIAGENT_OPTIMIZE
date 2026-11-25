# Second Mind Pi for macOS

适用于 macOS 14 或更新版本。在「关于本机」中，Apple 芯片选择 arm64，Intel 处理器选择 x64。两个 DMG 均为开源未公证构建，使用本地 ad-hoc 签名。

1. 从同一版本的 GitHub Release 下载 DMG 和 `SHA256SUMS.txt`。运行 `shasum -a 256 SecondMindPi-*.dmg`，与清单中对应的文件逐字比对。
2. 打开磁盘映像，把 **Second Mind Pi.app** 拖入「应用程序」。首次打开时，如果系统无法验证开发者，请在「系统设置 → 隐私与安全性」中为这个应用选择「仍要打开」。
3. 若已确认来源和哈希，可单独移除这个应用的下载隔离标记。

```sh
xattr -dr com.apple.quarantine "/Applications/Second Mind Pi.app"
```

桌面设置位于 `~/Library/Application Support/SecondMindPi`，模型凭据使用 macOS Keychain 保护。可用单独的示例 Vault 试用，选择自己的 Vault 时请避免两版同时写入同一份笔记。

## First launch

Choose arm64 for Apple Silicon or x64 for Intel. Both open-source builds require macOS 14 or later and use ad-hoc signatures. Compare the DMG's SHA-256 with the matching entry in the release checksum file before copying the app to Applications. If Gatekeeper flags the verified download, use **System Settings → Privacy & Security → Open Anyway**, or use the app-specific command above. Credentials use the macOS Keychain. Remove the Pi app from Applications to uninstall it.

## Rebuild

Run `npm ci` and `npm run desktop:build:mac` on the corresponding native Mac with Xcode Command Line Tools, Node 22 and Python 3.12. The build downloads and verifies Node.js, standalone CPython and the FFmpeg source before compiling FFmpeg with Apple system libraries. The runtime includes dependency licenses, its build lock and the per-architecture wheel list. FFmpeg source and build flags are available in the corresponding release's `scripts/macos/` directory and at [FFmpeg releases](https://ffmpeg.org/releases/).
