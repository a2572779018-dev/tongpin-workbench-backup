# 工作包 02：Worker 流式聊天请求上限

开工：2026-09-23（Asia/Hong_Kong）。基线：`codex/ai-continuation-20260923` @ `7fb5eb8`，工作树干净。目标：让真实 `/api/ai/chat/stream` 的外层请求体上限与 AI 内层同为 1600 KiB，避免合法附件在到达 AI 校验前被 768 KiB 通用入口误拒。

允许范围：只增加 `cloudflare/src/index.ts` 中 `bufferedApiRequest` 的 AI 专属路径和 `cloudflare/src/ai/runtime.workerd.test.ts` 的隔离运行时回归。`index.ts` 是共享入口，故先记录影响：任务/客户路径仍使用原 768 KiB；只有聊天流由 768 KiB 放宽至已存在的 AI 内层 1600 KiB，最大额外请求内存约 832 KiB。回滚只移除该 AI 路径，但会恢复误拒；不改数据结构或鉴权。

验证计划：测试先证明大于 768 KiB、小于 1600 KiB 的请求已进入 AI 服务而非 413；超过 1600 KiB 仍在外层 413。随后运行定向 workerd 测试与 Cloudflare 类型检查。所有出站请求由测试 fixture 拦截，不连接生产。

## 结果

- 测试先失败：800 KiB 流式聊天体被外层返回 413（预期进入 AI 内层），定位与源码相符。
- 最小改动：只在 `bufferedApiRequest` 的 AI 路径集合加入 `/api/ai/chat/stream`；普通任务/客户路径未变。测试断言 800 KiB 进入服务、超过 1600 KiB 仍 413。
- `npm test -- cloudflare/src/ai/runtime.workerd.test.ts`：17/17 通过；`npm run typecheck:cloudflare` 通过。该测试使用真 bundled Worker + SQLite DO 的隔离出站 fixture，不是线上服务商。

下一步：另行运行 `8787` 独立本地 Wrangler/DO 验证；当前**不能**称 `npm run test:cloudflare` 通过。发布仍未授权。
