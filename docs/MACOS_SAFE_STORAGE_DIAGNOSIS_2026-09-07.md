# Mac 客户脉络图安全存储排查（2026-09-07）

本轮只修改源码与测试，不发布、不替换已安装应用，不改钥匙串、签名、权限或用户数据。

## 结论与证据边界

用户截图的错误是“系统安全存储暂时不可用，请稍后重新尝试”。它来自安全存储适配器对原生临时不可用错误的分类，不等于客户图文件损坏。读取登录绑定和客户图都可能经过此适配器；没有读取用户密文或凭据来进一步区分具体文件。

已确认两项源码问题/限制：

1. 现有适配器在异步可用性检查失败后，会调用同步 `isEncryptionAvailable()`。Electron 官方说明 Mac 的同步安全存储调用可能等待钥匙串交互并阻塞主线程，故本轮禁止 Mac 在完整异步 API 可用时走这个回退。
2. 当前 Electron 的异步提供程序会缓存初始化结果。若首次获取钥匙串密钥暂时失败，仅重载页面或在同一进程内反复点“重新尝试”不一定重新获取密钥。系统授权恢复后，可能仍需完整退出应用再打开。

尚不能确定这台 Mac 的具体失败原因是授权被拒、钥匙串锁定、应用签名身份变化，还是其他系统错误。不能把上述源码机制或签名风险当成已证实的本机根因，也没有宣称旧客户图已经恢复可读。

## 本机只读核对

- 安装包为 `/Applications/同频.app`，版本 `0.1.34`，Electron Framework 为 `43.2.0`。
- 安装包中的 `safe-storage-adapter.cjs`、`relationship-graph-vault.cjs`、`relationship-member-verifier.cjs` 与本轮修改前检出源码逐字节相同，排除这三个文件仍为旧安装版本的假设。
- 2026-09-07 10:32（本机时区）对主进程 `77439` 做 1 秒采样，主线程主要停留在 AppKit/CFRunLoop 消息等待；没有观察到当时主线程阻塞在钥匙串调用。这只是一个时间切片，不能排除之前的同步阻塞。
- 签名元数据显示 `Signature=adhoc`、`Identifier=Electron`、没有 Team Identifier。它说明当前包缺少稳定的 Developer ID 身份，不证明本次临时不可用一定由签名引起。
- 有界、窄过滤的系统日志未给出该主进程具体安全存储拒绝原因。没有枚举或读取钥匙串条目，也没有输出账号、令牌、密钥或客户内容。

## 与当前版本匹配的上游依据

- [Electron safeStorage 官方文档](https://www.electronjs.org/docs/latest/api/safe-storage)：推荐非阻塞的异步接口；Mac 同步接口可能阻塞等待系统交互；应用签名连续性影响系统识别与授权。
- [Electron v43.2.0 safeStorage 实现](https://github.com/electron/electron/blob/v43.2.0/shell/browser/api/electron_api_safe_storage.cc)：`EnsureAsyncEncryptorRequested` 只初始化一次；`OnOsCryptReady` 缓存 encryptor；`DecryptStringAsync` 将 `flags.temporarily_unavailable` 映射为截图对应的临时错误。异步“可用”不等于每份旧密文一定能解密。
- [Electron v43.2.0 DEPS](https://github.com/electron/electron/blob/v43.2.0/DEPS)：本次实现对应 Chromium `150.0.7871.129`，不是用主分支推断安装版本。
- [对应 Chromium KeychainKeyProvider](https://github.com/chromium/chromium/blob/150.0.7871.129/components/os_crypt/async/browser/keychain_key_provider.mm)：系统取密钥在工作线程执行；`GetPassword()` 返回空值时会报告 `kTemporarilyUnavailable`。源码注明用户拒绝或其他错误都可能返回空值。
- [对应 Chromium OSCryptAsync](https://github.com/chromium/chromium/blob/150.0.7871.129/components/os_crypt/async/browser/os_crypt_async.cc)：临时不可用会保留为缺失密钥的提供程序状态，初始化完成后的 `GetInstance()` 使用缓存 encryptor。现有公开接口未提供可供同频调用的安全强制重置缓存操作。

## 本轮源码修改

- `electron/safe-storage-adapter.cjs`：当 Mac 具备完整异步 API 时，异步检查返回 false 或抛错都直接报告不可用，不再调用同步探测/加解密。Windows/Linux 原有回退不变；没有异步 API 的旧版 Electron 继续保留原同步加密格式兼容。
- `RelationshipMapApp.jsx`：仅 Mac 且错误以“系统安全存储暂时不可用”开头时，显示“若系统弹出同频的钥匙串访问提示，请确认后允许访问；随后完整退出并重新打开同频。”原有“重新尝试”和数据保留提示仍在。没有增加声称能自动修复的按钮。
- 客户图金库的按成员隔离、读取旧密文后才允许保存、版本冲突检查、原子替换逻辑未改变。只读加载即使收到 `shouldReEncrypt` 也不自动重写旧文件。
- 成员验证器逻辑未修改：仍需在线确认成员身份，只有网络/服务器故障才可读取匹配的加密本机会话绑定；401/403、成员身份不符不能使用离线兜底。

没有明文回退，没有自动新建密钥覆盖旧密文，没有删除损坏文件的恢复流程，也没有改主进程启动/登录流程。

## 安全恢复与仍需外部条件的工作

1. 若 macOS 显示钥匙串授权提示，先核对确为同频的请求，再由用户确认授权。
2. 完整退出并重新打开同频，再进入客户脉络图。仅关闭窗口或重载页面可能不会重建异步提供程序。
3. 如仍不可用，保留现状再收集不含敏感内容的错误类型/系统状态；不要清空钥匙串、删除本机数据目录或生成新密钥“恢复”。

稳定的 Developer ID 签名、公证与升级前后读取同一份旧密文的真实验证，仍属于后续发布条件。此次未更改签名，也不能用模拟测试替代这台 Mac 实际成功解密的验收。

## 验证

专项命令：

```sh
npx vitest run src/lib/safeStorageAdapter.test.ts src/lib/relationshipGraphVault.test.ts src/lib/relationshipMemberVerifier.test.ts src/lib/secureSessionBindingStore.test.ts src/lib/credentialVault.test.ts src/features/relationship-map/RelationshipMapApp.test.mjs src/lib/relationshipMapIntegration.test.ts
```

结果：7 个文件、73 个测试通过。新增用例覆盖：

- Mac 异步探测 false/抛错时同步接口调用为零；Windows 原有回退和旧同步格式兼容保留。
- 临时解密失败时加载/保存都拒绝，原密文逐字节保留，不创建临时文件、不调用新加密；模拟提供程序恢复后可读原版本并保存下一版本。
- 新版本加密失败时旧文件与版本均不变。
- Mac 临时安全存储错误显示恢复指引；Windows/Linux、登录/网络/数据损坏错误不显示钥匙串归因。

测试使用隔离临时目录和模拟加密提供程序，不接触系统真实钥匙串或用户数据。模拟提供程序恢复只验证应用的失败/重试契约，不代表 Electron 会在同进程中自动重新获取密钥。

本轮并行工作区在 2026-09-07 10:43 的全量快照中，`npm run typecheck` 通过，`npm test` 为 95 个文件、746 个测试全部通过，`git diff --check` 通过。随后 `node --check electron/safe-storage-adapter.cjs` 和 `npm run build:web` 通过。该结果不替代后续集成变更后的最终验证或本机实际解密验收。
