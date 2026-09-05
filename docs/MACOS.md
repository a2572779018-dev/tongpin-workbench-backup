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

私人 GitHub 仓库中的 `Desktop builds` 与 `Desktop release` 工作流都会构建 Mac 通用包，但目前显式设置 `identity=null`、`hardenedRuntime=false`、`notarize=false`。因此，即使 GitHub Release 使用正式版本号，这些 Mac 安装包仍未获得 Developer ID 签名和 Apple 公证，不能宣称已通过 Gatekeeper 信任验证，也不能切换 Mac 自动更新清单。

未签名包只能作为明确标注该限制的手动安装文件提供；系统可能阻止打开，需要用户按照 macOS 的安全提示处理，不保证只靠 Finder 右键就能通过。不要关闭系统安全保护作为发布步骤。

## 手动分发，保持自动更新清单不变

从已通过构建检查的 Release 取得同一版本的 DMG、ZIP、blockmap 和 `latest-mac.yml`，放入 `artifacts/`，或通过 `RELEASE_DIR` 指向独立目录。先验证、再只上传版本化文件：

```bash
npm run release:verify:mac
npm run release:upload:mac
```

以上两条命令不会切换 `latest-mac.yml`。向成员提供公开更新源上的对应 DMG 下载链接；私有 GitHub Release 链接不保证成员可以访问。此阶段不要运行 `release:activate:mac` 或会激活双端清单的 `release:upload`。`release:verify:remote:mac` 检查的是当前线上清单指向的版本，不能将它通过误认为新手动安装包已经开放自动更新。

## 正式签名与自动更新

面向 macOS 系统信任的正式分发和自动更新，需要 Apple Developer Program 的 Developer ID Application 证书和 Apple 公证。采用 App Store Connect API Key 方式公证时，构建环境应安全提供：

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_TEAM_ID`

还需修改上述工作流：移除禁用签名、公证的覆盖参数与 `CSC_IDENTITY_AUTO_DISCOVERY=false`，启用 hardened runtime，并正确接入签名、公证凭证。仅添加 Secrets 不会改变目前明确禁用签名的构建行为。不要将凭证提交到仓库或写入安装包。

构建后检查实际应用的 Developer ID 签名、Gatekeeper 评估和公证票据，再验证 ZIP、DMG、arm64/x86_64 架构。`release:verify:mac` 只核对文件、清单和哈希，不替代签名、公证验收。以上验收完成后，按顺序执行：

```bash
npm run release:verify:mac
npm run release:upload:mac
npm run release:activate:mac
npm run release:verify:remote:mac
```

`release:upload:mac` 上传并完整验证版本化文件；`release:activate:mac` 再次核对全部远端产物后才切换 `latest-mac.yml`，最后独立验证线上更新版本与完整下载。中央 API 有变更时，必须先部署并验证后端，再激活客户端更新。

Windows 继续使用独立的 `latest.yml`。单平台发布使用对应的 `release:upload:win/mac` 与 `release:activate:win/mac`，两套更新清单不会互相覆盖；只有两端均满足各自发布条件时，才可使用会激活双端的 `release:upload`。
