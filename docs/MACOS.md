# 同频 macOS 构建与发布

同频的 Windows 与 macOS 客户端共用同一个业务后端：

- API：`https://notify.samhubs.com`
- 更新源：`https://notify.samhubs.com/releases`
- Windows 更新清单：`latest.yml`
- macOS 更新清单：`latest-mac.yml`

同一个账号在两台电脑登录后会读取相同的任务、联系人、消息和通知。登录会话由各系统安全存储分别保管，因此第一次在 Mac 上使用时需要重新登录。

## 本地开发

要求 Node.js 24 或更高版本。

```bash
npm ci
npm run dev
```

## 构建 Mac 通用包

```bash
npm run dist:mac
```

该命令同时构建 Intel（x86_64）与 Apple Silicon（arm64）通用应用，并在 `artifacts/` 生成 DMG、ZIP、blockmap 和 `latest-mac.yml`。DMG 用于首次安装，ZIP 与 `latest-mac.yml` 用于自动更新。

私人 GitHub 仓库中的 `Desktop builds` 工作流也会同时构建 Windows 安装包和无签名的 Mac 通用测试包。无签名包只适合内部测试，首次打开需要在 Finder 中右键应用并选择“打开”。

## 正式签名与自动更新

正式分发需要 Apple Developer Program 的 Developer ID Application 证书和 Apple 公证。构建环境应提供：

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_TEAM_ID`

正式包完成签名和公证后，先上传 DMG、ZIP 与 blockmap，最后上传 `latest-mac.yml`：

```bash
npm run release:verify:mac
npm run release:upload:mac
npm run release:verify:remote:mac
```

Windows 继续使用独立的 `latest.yml`，两套更新清单不会互相覆盖。
