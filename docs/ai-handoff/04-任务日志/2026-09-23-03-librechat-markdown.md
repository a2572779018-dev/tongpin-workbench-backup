# 工作包 03：LibreChat 流式 Markdown 分块接入真实聊天

开工：2026-09-23（Asia/Hong_Kong）。基线：`codex/ai-continuation-20260923` @ `2c379e8`，工作树干净。目标：把 LibreChat 已完成块稳定复用能力接入同频现有 `ChatMessageRow → MarkdownReply`，让真实 `answer_delta` 到达时已完成的段落/表格/代码无需随末尾增量重解析，并维持保存重开同一渲染路径。

选定上游：LibreChat `9e74cc0e57b395926122bd4062c1fcedc48ed465`（v0.8.7），`client/src/components/Chat/Messages/Content/splitMarkdown.ts`、`MarkdownBlocks.tsx` 及同目录测试。MIT Copyright (c) 2026 LibreChat。采用源码抽取并按同频目前 GFM 渲染管线裁去未启用的 math/directive 和 code/artifact 索引 Provider；不声称迁入 LibreChat 完整后端。保留原理与上游测试边界，另加同频安全与旧消息等价测试。

允许修改：`src/features/tongpin-ai/MarkdownReply.tsx` 和同目录新分块模块/测试；必要直接 npm 依赖及锁文件；`THIRD_PARTY_NOTICES.md`、本知识库。共享全局 CSS、业务模块、身份、账本、Cloudflare 路由不改。若新增 npm 依赖，仅采用已存在的 GFM 解析依赖，不做全仓升级。回滚通过该工作包提交撤销；存储消息格式本步不变，旧版本仍可读。

验收：先红测试分块边界、引用定义保全和真实 `ChatMessageRow` 流式/重开等价；随后定向测试、类型检查、Web 构建。对于版本化事件、富媒体 parts、断线语义等本工作包未改的内容，仍保持待办，不以本步伪称整个 T03/T05/T07 通过。

## 结果

- 先红：新增上游边界改编测试在模块缺失时失败（`Cannot find module './librechatMarkdownBlocks'`）。
- 已接入：GFM `mdast` 顶层分块 + 已完成块 `memo`；`MarkdownReply` 在真实 `ChatMessageRow` 的 SSE 增量路径调用该模块。最终打字动画沿用既有效果，但解析也走相同分块器；现有用户输入、错误、来源和资产卡路径未动。
- 兼容：消息仍以原纯文本内容保存；新渲染器对引用定义与顶层 HTML 退回整条解析。旧同频客户端可读同一存储内容，不涉及消息结构迁移或供应商扣费。
- `npm test -- src/features/tongpin-ai/librechatMarkdownBlocks.test.ts src/features/tongpin-ai/MarkdownReply.test.ts`：11/11 通过；覆盖流增长、表格、代码、列表、定义、HTML、安全链接、实际聊天行中流时显示与保存后重开。
- `npm run typecheck`、`npm run build:web` 通过。源代码、许可证、精确上游路径和依赖已记录在 `THIRD_PARTY_NOTICES.md`。本地测试只证实组件/构建，**未**证明真实服务商在终态前输出，也**未**证明 200ms p95 或完整版本化块协议。

下一步：在真实 AI 流上增加可去重、可恢复的版本化富内容事件；本模块仅解决 Markdown 已完成块重解析，不代替该协议。准备独立本地 Worker 8787 回归。发布仍未授权。
