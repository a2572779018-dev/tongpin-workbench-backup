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

## 本机稳定签名（可选，推荐自己打包安装的 Mac）

默认的 `npm run dist:mac` 不做签名，应用只带 Electron 自带的 ad-hoc 签名（`codesign -dv` 显示 `Signature=adhoc`、`Identifier=Electron`、没有 Team ID）。macOS 按这个临时身份记录钥匙串授权和隐私权限，而每次重新打包或更新身份都会变：

- 打开新版本时，钥匙串会再次询问能否读取“同频 Safe Storage”。拒绝或没注意到提示时，保存的登录状态和“记住密码”都无法解密，只能重新登录（同频保留账号、给出一句原因，不会卡住登录）。
- “辅助功能 / 屏幕录制”等隐私权限需要重新授权。

用同一张本机证书签名，可以让应用身份在更新前后保持不变。只需做一次：

1. 在这台 Mac 的“终端”、项目根目录运行：

   ```bash
   bash scripts/mac-create-local-signing-identity.sh
   ```

   脚本生成一张仅用于代码签名的自签名证书（默认名称 `Tongpin Local Code Signing`），导入当前用户的登录钥匙串，并只在当前用户的信任设置中把它设为“代码签名：始终信任”（macOS 会弹窗要求输入登录密码）。不使用 sudo，不改系统钥匙串，不自动运行；重复运行是安全的。

2. 以后打包都带上环境变量：

   ```bash
   TONGPIN_MAC_SIGN_IDENTITY="Tongpin Local Code Signing" npm run dist:mac
   ```

   手动执行 electron-builder（例如只打 `--arm64` 单架构）时，把命令里的 `electron-builder` 换成 `node scripts/electron-builder-mac.cjs`，参数不变。

3. 第一次用证书打包时，codesign 可能询问能否使用私钥：选“始终允许”。第一次打开用它签名的同频时，钥匙串会询问能否读取“同频 Safe Storage”：输入登录密码后选“始终允许”；隐私权限重新勾选一次。

说明与限制：

- `scripts/electron-builder-mac.cjs` 只根据环境变量选择签名方式：未设置 `TONGPIN_MAC_SIGN_IDENTITY` 时传 `mac.identity=null`，结果与以前的包完全相同；设置 `CSC_LINK`/`CSC_NAME` 时交给 electron-builder 的正式签名流程；两者同时设置会直接报错。
- 本机证书模式关闭 hardened runtime、公证和 Apple 时间戳，与现有 ad-hoc 包的运行方式一致：自签名证书没有 Apple Team ID，hardened runtime 的库校验会拒绝加载 Electron 框架导致应用无法启动。`build/entitlements.mac*.plist` 仍会写入签名，不影响运行。
- 证书不变时，应用的签名要求（`identifier "com.tongpin.workbench" and certificate leaf = H"…"`）在更新前后不变，钥匙串访问列表和隐私权限都能认出更新后的同频。自签名证书没有 Team ID，macOS 钥匙串的“分区”检查对这类应用可能仍按单次构建区分，更新后若再弹一次钥匙串提示，输入登录密码并选“始终允许”即可；要彻底不弹只能改用下文的 Developer ID。
- 从 ad-hoc 第一次切换到本机证书时，钥匙串授权和隐私权限都要按新身份确认一次。
- 本机证书不经过 Apple 公证，Gatekeeper 仍不信任，只适合装在自己的 Mac 上，不要对外分发。
- 检查已安装的应用：`codesign -dv --verbose=2 /Applications/同频.app 2>&1 | grep -E "Authority|Identifier"` 应显示 `Authority=Tongpin Local Code Signing` 与 `Identifier=com.tongpin.workbench`；`codesign --verify --deep --strict /Applications/同频.app` 不应输出错误。
- 撤销：打开“钥匙串访问” → 登录 → 我的证书，删除同名证书；之后不带环境变量打包即回到 ad-hoc。

## 记住密码与系统安全存储

- 登录页“记住密码”默认不勾选。勾选并登录成功后，密码由主进程用 Electron safeStorage 加密（Mac：登录钥匙串中的“同频 Safe Storage”密钥；Windows：当前 Windows 用户的 DPAPI），只保存在本机应用数据目录的 `secure-account-passwords.json`（权限 0600）。不明文落盘、不进 localStorage、不写日志；Linux 开发环境不保存密码。
- 只有在登录页点选已记住的账号时才解密并自动填入；已登录时主进程拒绝读取。
- 登录时取消勾选、在账号列表点“移除”、或用“忘记密码”重置密码，都会删除保存的密码（账号记录按“记住账号”处理）。
- 钥匙串被拒绝或锁定：保留加密数据，提示手动输入并选“始终允许”；密钥已变化（例如更新后无法解密）：只删除这一条密码，账号保留，提示重新输入，登录时可再次保存。任何情况下都不阻止登录。

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
