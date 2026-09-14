# 同频 0.1.42 发布验收

## 源码与安装包

- 用户要求部署、推送更新并安装到本机 Mac。
- 源码及标签：`799c945f8c802bce1b0d39e524f76e606ebae485`、`v0.1.42`。
- 本地完整构建通过：119 个测试文件、1167 项测试；Worker 类型检查和 dry run 通过。
- GitHub Actions `34832414207` 的质量检查、Windows 包、Mac 通用包与发布全部成功。
- GitHub Release `388306547` 于 `2026-09-14T10:26:57Z` 发布，八个资产完整。
- 本次是桌面端改动，沿用已部署后端，不修改生产密钥、额度或业务数据。

## Mac 安装

- DMG：232114538 字节；SHA-256 `8b6b632f25c93d204b1b266b679acc5ade88c25168561d6e176eba5604217154`，独立下载与 GitHub 摘要一致。
- `hdiutil verify` 通过；包内版本 0.1.42，包含 x86_64、arm64；12 个必需 ASAR 条目与生产服务地址检查通过。
- 退出旧版后，将其移动到 `/Users/sam/.Trash/同频-0.1.41-before-0.1.42.app`，可恢复。
- 新版安装在 `/Applications/同频.app`；安装后的 ASAR 与挂载源哈希一致：`26d320b4c7748d961a5607c5571229d1e425e7a31a8d95edc25c5cf5fb6d543e`。
- 原生界面显示 v0.1.42，小秋登录、任务、两个项目及第九次等历史对话恢复。
- 点击“生成视频”已在实际安装版验证：参数与参考图片入口直接出现在聊天输入区，无独立弹窗；测试后取消，未发送或生成付费视频。
- Application Support 和 Keychain 未作清理或修改，未绕过 Gatekeeper。

## Windows 与线上分发

- EXE：110422074 字节；SHA-256 `6bb9fa0f023e0e3e7d3ffd13586627b45ce476f1d63cbe34cfaec5d1660e4e8a`。
- blockmap：117480 字节；SHA-256 `efb2d61d7840067622f9f1727f58d75e09c95750aeb1f02c6903291036e62872`。
- `latest.yml`：826 字节；SHA-256 `35dca4c707b0c7039f8ae535a273482e7ded8df6e2cfdad5060b5f26314166fb`。
- 三个文件均独立下载，并与 GitHub 摘要校验一致。
- EXE、blockmap 先上传，再从公开地址读回全部字节。大分段校验超时后改用可恢复的 256 KiB 分段：422 个 EXE 分段与 1 个 blockmap 分段逐字节匹配本地已通过 GitHub 摘要验证的文件；前后 ETag 不变。
- 校验通过后才上传 `latest.yml`，随后完整读回与本地清单匹配。公开 Windows 更新入口已指向 0.1.42、110422074 字节与 SHA-512 `Nlt5v1RrEc1qpOl5f2BlTSvS/mU36widgbZLdtSOm6d0WEJO7mmxEOql60ARWBavkE78ziCIgIwskqKyJMddXw==`。
- Windows 更新已可获取，不代表每一台成员电脑已经完成安装。
- `2026-09-14T10:56:39Z` 生产 health 正常，未认证视频端点返回 401。
- Mac 公共安装包 222 个分段完整读回，232114538 字节和 SHA-256 均与 GitHub/本地 DMG 匹配。公开下载地址：`https://notify.samhubs.com/releases/Tongpin-0.1.42-mac-universal.dmg`。
- Mac 自动更新清单仍为 0.1.28，未为未签名包启用自动升级；本机已手动安装 0.1.42。
- 未认证上传端点返回 404，未写入测试对象。
- 本次未提交新的付费视频生成；内嵌播放器与刷新恢复的合成视频验收记录见 `ai-video-chat-20260914.md`，实际安装版验证了入口、设置和已有数据恢复。
