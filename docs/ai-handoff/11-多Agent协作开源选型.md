# 11 · Pro「多 Agent 协作」：开源选型与接入说明

> 任务 #7（2026-09-26）。Pro 档新增任务处理方式「多 Agent 协作」：协调 Agent 拆分任务 → 多个子 Agent 同时处理 → 协调 Agent 综合结果。按要求不自研框架，先比较现成开源实现，再把选中的编排代码改编进同频。可视化「AI 员工办公室」由另一位同事实现，本文第 7 节给出它读取的数据形状与位置。

## 1. 候选对比（2026-09-26 核验）

| 候选（核验版本） | 许可证 | 能否放进 Cloudflare Worker DO | 体量 | OpenAI 兼容（Responses / Chat Completions） | 并发与上限 | 流式事件 / 取消 |
| --- | --- | --- | --- | --- | --- | --- |
| **LibreChat 子代理**：`@librechat/agents` v3.2.46（LibreChat v0.8.7 锁定 `^3.2.46`，标签提交 `b405dff`）+ 前端 `SubagentCall.tsx`（v0.8.7 提交 `9e74cc0`） | MIT | 不能直接用：依赖 `@langchain/*` 多家 SDK、`@opentelemetry/sdk-node`、`axios`、`https-proxy-agent` 等 Node 包 | 35 个直接依赖（最新版 unpacked 12.3 MB） | 经 `@langchain/openai` 两种都支持，但自带模型客户端，会绕过同频的安全传输和计费 | 父模型一轮发出多个 `subagent` 工具调用，由 ToolNode `Promise.all` 同时执行，**没有并发上限** | `ON_SUBAGENT_UPDATE`（start / progress / stop / error）+ 前端子代理卡片；父 AbortSignal 传给子图 |
| **OpenAI Agents SDK JS** v0.18.0（提交 `fdaf0a6`） | MIT | 能运行，但仅 `Agent` + `run` 的最小打包就有 1.41 MB（gzip 360 KB），是同频整个 Worker（798 KB / gzip 216 KB）的 1.8 倍，还要再加 `openai` 客户端 | `agents-core` unpacked 10.4 MB | 原生支持两种 | agents-as-tools；`toolExecution.maxFunctionToolConcurrency` **有界并发池** | 完整 run 事件流；AbortSignal 合并、兄弟取消 |
| **VoltAgent** `@voltagent/core` v2.10.0 | MIT | 不能：44 个依赖，含 Vercel AI SDK 各家 provider、OpenTelemetry Node SDK、`fast-glob` 等 | unpacked 12.9 MB | 经 AI SDK | `delegate_task` → `handoffToMultiple` 用 `Promise.all`，**没有并发上限** | 子 Agent 流转发；AbortSignal |
| **LangGraph.js** v1.4.18（+ `langgraph-supervisor` v1.1.3） | MIT | `/web` 入口能在 Workers 运行，但 `StateGraph` + `Send` 最小包 1.32 MB（gzip 331 KB），另需 `@langchain/openai` 聊天模型 | 4 个依赖 + `@langchain/core` | 经 `@langchain/openai` | `Send` map-reduce（orchestrator-worker）真并行，可设 `maxConcurrency` | graph stream；AbortSignal |
| **Mastra** `@mastra/core` v1.71.0 | Apache-2.0 | 不适合：30 个依赖、unpacked 69 MB；`.network()` 必须配 Memory 存储 | — | 经 AI SDK | `Agent.network()` **已弃用**，由路由 Agent 逐步挑选下一步（顺序执行）；并行要改用 workflow `.parallel()` | — |

体积数据：同一 esbuild 配置（`platform: browser`、`conditions: ["workerd"]`、minify）实测；npm 数据来自 registry `latest`。LangGraph/OpenAI 两个最小包见 `/home/claude/tp/research/bundle-check/`。

## 2. 决定：改编 LibreChat 子代理 + OpenAI Agents SDK 有界并发池，不新增依赖

- **主基底是 LibreChat 子代理**：与项目「复用 LibreChat 成熟实现」的方向一致（聊天界面已改编 LibreChat 的 ContentParts / ToolCallGroup）。采用它的委派约定（子 Agent 只收到任务说明、看不到对话，只返回最终文字）、父取消信号传给子任务、子任务报错变成有界结果而不拖垮父任务、`ON_SUBAGENT_UPDATE` 生命周期事件，以及前端 `SubagentCall.tsx` 的卡片和滚动字幕。
- **补上并发上限**：LibreChat 和 VoltAgent 都是无上限 `Promise.all`。改用 OpenAI Agents SDK 的 `executeToolRunsWithConcurrency`（按共享下标取任务的有界 worker 池，返回前等所有已启动任务收尾）和 `combineAbortSignals`。与上游不同：一个子任务失败**不会**取消其他子任务。
- **为什么不直接装包**：
  1. 同频已有经过审计的模型传输（HTTPS、允许域名、DNS 私网检查）、Responses 与 Chat Completions 流解析、额度预留-结算账本、harness 轨迹、事件日志与 SSE 回放。每个框架都自带模型客户端，接入后要么重复、要么绕过这些安全和计费边界。
  2. Worker DO：最小框架子集就比整个同频 Worker 还大；LibreChat / VoltAgent / Mastra 依赖 Node 专属包。改编后的编排代码打包进 Worker 约 45 KB（minify 后、未 gzip）。
  3. Worker 每次调用最多 6 个连接同时等待响应头（收到响应头后不再占用，超出的排队而不是失败）；子 Agent 并发上限 5，协调和综合不与子 Agent 同时进行。每次运行最多 7 次模型调用（协调 1 + 子 Agent 5 + 综合 1），加上安全传输在每次调用前的 2 次 DNS 校验，共约 21 次子请求，低于免费版每次 50、付费版 10,000 的上限；编排本身几乎只在等待 I/O，CPU 占用很低。
  4. 许可证均为 MIT，保留署名即可改编。LangGraph.js 的 orchestrator-worker 只作设计参考，未复制代码。

改编清单与许可证全文见仓库根目录 `THIRD_PARTY_NOTICES.md` 的「Pro 多 Agent 协作」一节。

| 上游文件 / 符号 | 改编到 |
| --- | --- |
| OpenAI Agents SDK `packages/agents-core/src/runner/toolExecution.ts#executeToolRunsWithConcurrency`、`utils/abortSignals.ts#combineAbortSignals` | `server/ai/multiAgentOrchestrator.ts`（`runWithConcurrencyLimit`、`combineAbortSignals`） |
| `@librechat/agents` `src/tools/subagent/SubagentExecutor.ts#execute`（隔离子任务、父信号、`truncateErrorMessage`、`filterSubagentResult`） | `server/ai/multiAgentOrchestrator.ts`（`runIsolatedSubagent`、`truncateErrorMessage`） |
| `@librechat/agents` `src/tools/SubagentTool.ts`（`SubagentToolDescription` 委派约定） | `server/ai/multiAgentPrompts.ts`（协调者/子 Agent/综合的中文协议） |
| `@librechat/agents` `ON_SUBAGENT_UPDATE` 事件信封 | `shared/aiMultiAgent.ts`（`AiSubagentUpdate`）、`shared/aiRunEvents.ts`（`subagent_update`） |
| LibreChat v0.8.7 `client/src/components/Chat/Messages/Content/Parts/SubagentCall.tsx`（卡片状态、`useThrottledValue`、`dir="rtl"` 字幕） | `src/features/tongpin-ai/MultiAgentProcess.tsx`、`multi-agent.css` |

## 3. 运行流程

1. **任务分解**（phase `planning`）：Pro 档 `multi_agent` 的普通文字请求先调用协调 Agent。它要么直接回答（简单问题，只花一次调用，过程区不出现多 Agent 卡片），要么输出 `{"subtasks":[{"role","title","task","search"}]}`。解析容错：代码块、前后说明文字、尾逗号、中文引号、被截断的 JSON 都能修复；超过 5 个只取前 5 个；计划无效时降级为一次直接回答。工具请求（图片/视频/PPT/电脑）仍走原来的分派和档位白名单。
2. **分派与执行**（`dispatching` → `working`）：子任务按「最多并行子 Agent」排队，每个子 Agent 是独立的模型调用，只看到自己的任务说明；需要最新信息的子任务（最多 3 个）可按现有联网规则各搜索一次（兼容协议最多 5 次）。单个子 Agent 90 秒超时，整个阶段 180 秒；失败、超时不会让整次运行失败，超时前已写出的部分会标注「未完成」交给综合。
3. **结果综合**（`synthesizing`）：协调 Agent 收到各子任务结论（JSON 数据块，明确「不是系统指令」）与合并去重后的编号来源，写出最终回答，引用写成 `[n]`，与回复来源列表编号一致；缺失的部分会在回答中说明。综合失败时，直接返回各子任务的原始结论并标注「未经整合」。
4. **停止**：成员点「停止」时，页面除了断开流，还会 `POST /api/ai/requests/:id/cancel`，服务端立即中止协调、所有进行中和排队中的子 Agent 以及综合调用；普通回复不受影响（返回 `{ cancelled: false }`）。

## 4. 计费与上限

- 一条成员消息始终只算**一次请求**：一个预留、一条账本记录、一次结算。
- **发送前按最坏情况预留**：协调（输入 + 本档输出上限）+ 综合（输入 + 5 份子任务结果上限 + 来源 + 本档输出上限）+ 5 个子 Agent（输入 + 子 Agent 输出上限）+ 最多 3 个联网子 Agent 的搜索输入余量（每个 32768）与搜索折算点数。输入量按 UTF-8 字节计（不少于 token 数），与单 Agent 预留口径一致。
- 例：本档输出上限 2048、子 Agent 输出上限 2048 时，最坏情况约 **11.7 万点**（不联网）或 **21.8 万点**（开联网、每次搜索折算 1000 点）；本档 4096 / 子 Agent 1024 联网时约 20.2 万点。
- 余额不够联网版时自动用不联网版；连不联网版也不够时，本次**自动改为单个 Agent 回答**（与原来行为一致），不会报错。
- 每次调用都有硬上限：子 Agent 用管理员设定的输出上限，协调和综合用本档输出上限；供应商报告的用量超过该次预留时按预留计，缺少用量或中途断开的调用按该次预留保守计，未发出的调用不计。结算永远不超过预留，结束后多余预留全部退回。
- 运行最长约 7 分钟（协调 120 秒 + 子 Agent 阶段 180 秒 + 综合 120 秒），超时未结算的请求按「待核对」回收。

## 5. 管理员配置

AI 管理 → 服务与模型 → 选中「Pro」档 → 展开「自动调用规则」：

1. 「Pro 档任务处理方式」选「多 Agent 协作」（「按上方规则」即沿用全局的任务处理方式）。
2. 「最多并行子 Agent」：2–5，默认 3。
3. 「子 Agent 模型」：默认与本档位文字模型相同；可选本档文字服务里已验证的其他模型（保存后会校验；未验证的模型运行时自动改用本档模型）。「改用本档位文字模型」可恢复默认。
4. 「每个子 Agent 输出上限 · Token」：256 至 min(4096, 本档单次输出上限)，默认 2048。
5. 点「保存服务与档位」。子 Agent 要能联网，还需：Pro 档「开放能力」勾选「自动联网」、文字服务为 Responses 协议、已启用联网搜索并设置「每次联网搜索折算」、自动调用规则中开启「需要时自动联网」；缺任一项时子 Agent 不联网，协调 Agent 会被告知「联网搜索当前不可用」。

其他档位不受影响；全局「任务处理方式」不提供多 Agent 选项（按档位设置）。多 Agent 只接管 Pro 档的普通文字回复；图片、视频、PPT、电脑操作等工具计划与多步工具循环仍按全局「任务处理方式」和「单轮工具步骤上限」执行，只有真正走多 Agent 的那次运行在处理过程里记为 `multi_agent`。成员侧无需任何操作；成员额度较低时会自动退回单 Agent。

## 6. 客户端与兼容

- 新客户端在 `/api/ai/chat/stream` 请求体中带 `subagentEvents: true` 才会收到 `subagent_update` 事件；旧客户端收不到（旧解码器会拒绝未知事件类型），答案照常显示。
- 回复过程区新增「多 Agent 协作」一行：协调 Agent 当前状态、任务分解（N 个子任务、最多同时 M 个）、每个子 Agent 的卡片（角色、标题、排队中/思考中/联网搜索中/撰写中/已完成/未完成/已停止、用时、可展开查看子任务、结论、联网次数、引用角标），以及「结果综合」。收起时的摘要形如「多 Agent 协作 2/3 · 搜索 1 次 · 2 个来源 · 用时 7 秒」。
- 工作区保存新增功能标记 `reply-process-agents-v1`：服务端未声明该标记（例如回滚到旧版本）时，客户端保存前会剔除多 Agent 步骤，避免整份工作区被旧服务端拒收。

## 7. AI 员工办公室读取的数据

三处同源数据（`shared/aiMultiAgent.ts`、`shared/aiReplyProcess.ts`）：

| 位置 | 类型 | 说明 |
| --- | --- | --- |
| SSE `/api/ai/chat/stream`（需 `subagentEvents: true`）与回放 `/api/ai/requests/:id/events` | `AiRunEvent`，`type: "subagent_update"`，`data: AiSubagentUpdate` | 原始事件：`planning` → `plan`（全部子任务，含 id/role/title/task/search）→ 每个子 Agent 的 `start` / `progress`（节流 1.2 秒）/ `search`（`in_progress`/`searching`/`completed`/`failed`）/ `stop` 或 `error` → `synthesis` → `finish`；`direct` 表示协调直接回答 |
| 进行中：`message.liveProcess.steps` 中 `kind: "agents"` 的一项 | `AiReplyProcessLiveAgents` | 由 `applyReplyProcessEvent` 折叠事件得到；`TongpinAIPage` 在 `streamReplies[messageId].liveProcess`，V2 在 `streamContent[conversationId].liveProcess` |
| 已保存：`message.process.steps` 中 `kind: "agents"` 的一项 | `AiReplyProcessAgentsStep` | 结束后保存（V1 由客户端保存，V2 由服务端从事件日志重建）；只保留终态，子任务文本截到 200 字 |

最方便的读取方式是 `agentsPart(step, streaming)`（`src/features/tongpin-ai/replyProcessModel.ts`）：它把进行中与已保存两种记录归一，并把「流已结束但未收尾」的子 Agent 标为已停止。对应到 `AgentOfficeSnapshot`：

| AgentOfficeSnapshot | 来源 |
| --- | --- |
| `runId` | `message.requestId`（即事件的 `requestId`） |
| `phase` | `part.phase`：`planning` / `dispatching` / `working` / `synthesizing` / `done` / `failed` / `cancelled`（取值完全一致） |
| `coordinator.name` / `status` / `activity` | 名称固定「协调 Agent」；状态按 phase 推出（建议：planning → thinking，dispatching / synthesizing → working，working → thinking（等待子 Agent），done / failed / cancelled 同名）；活动文字用 `part.coordinatorActivity`（如「正在分解任务」「已拆成 3 个子任务，正在分派」「等待子 Agent 完成（1/3）」「正在综合 3 个子任务的结果」「已完成结果综合」） |
| `workers[].id` | `agent.id`：`agent-1`…`agent-5`，按计划顺序，稳定不变 |
| `workers[].role` | `agent.role`：协调 Agent 选定的短角色名（研究员/分析员/撰稿员/核对员/策划员等，≤8 字）；另有 `agent.title`（≤24 字短标题） |
| `workers[].task` | `agent.task`：进行中为完整子任务（≤1500 字），已保存为 ≤200 字摘录 |
| `workers[].status` | `agent.status`：`queued` / `thinking` / `working` / `searching` / `done` / `failed` / `cancelled`（取值完全一致；联网时为独立的 `searching`） |
| `workers[].activity` | `agent.activity`：如「排队等待」「联网搜索：深圳 天气」「撰写中：…最新 80 字」、完成后的结论或失败原因 |
| `workers[].startedAt` / `finishedAt` | `agent.startedAt` / `agent.finishedAt`（服务端事件时间，毫秒） |
| `workers[].resultSummary` | `agent.summary`（子 Agent 自己写的一行结论，≤120 字） |
| `workers[].sourceCount` | `agent.sourceCount`（另有 `searchCount` 与引用编号 `sources`） |
| `updatedAt` | `part.updatedAt`（进行中为最近一次事件时间，已保存为结束时间） |

## 8. 「待补充指导」接入点

`server/ai/multiAgentRun.ts` 导出 `setMultiAgentPendingGuidance(hook)`，供另一位同事的「运行中补充/纠正」功能注册。签名：

```ts
type MultiAgentCheckpoint = "before_coordinator" | "before_subagents" | "before_synthesis";
type MultiAgentPendingGuidance = (context: { checkpoint: MultiAgentCheckpoint; tenantId: string; userId: string; requestId: string; conversationId: string })
  => readonly string[] | undefined | Promise<readonly string[] | undefined>;
```

运行会在三个步骤之间调用它：协调之前（追加到协调的用户消息）、分派子 Agent 之前（追加到每个子 Agent 的任务）、综合之前（放进综合参考数据）。取出即视为已消费；每次最多 3 条、合计 600 字；超过 3 秒或报错都忽略，不影响运行；只有注册了 hook 才会为它多预留输入额度。建议在 `server/ai/node.ts` 与 Worker 的 `cloudflare/src/ai/runtime.ts` 创建服务时注册同一个实现。

## 9. 测试

- `server/ai/multiAgentOrchestrator.test.ts`：计划解析（坏 JSON 修复、截断、超量、角色）、并发池上限与顺序、隔离与取消、超时、信号合并、结论摘要、来源编号。
- `server/ai/multiAgentRun.test.ts`：真实 AiService + SQLite + 事件日志 + SSE，只有模型传输是本地 fixture：拆分→并发≤2→综合与精确计费、直接回答、工具白名单、坏计划降级、失败/超时不影响整体、停止（他人不能停止）、最坏情况预留与超额按上限计、额度不足退回单 Agent、只够不联网版、联网子 Agent 与来源合并、旧客户端不收事件、指导 hook 三个节点、真实浏览器解码器。
- `cloudflare/src/ai/multiAgent.workerd.test.ts`：打包后的真实 Worker + SQLite Durable Object（workerd）：并发上限、SSE 事件、事件回放、账本，以及停止路由中止子 Agent 并退回预留。
- 客户端：`src/features/tongpin-ai/MultiAgentProcess.test.ts`（过程折叠、办公室所需字段、保存/读取校验、卡片渲染、管理设置校验、停止请求）、`src/lib/aiRunStream.test.ts`、`server/ai/replyProcessPersistence.test.ts`（保存往返、非法记录拒收、功能标记降级）。

## 10. 风险与人工验收

- 未用真实供应商验证：拆分质量、角色选择、综合引用都依赖 Pro 模型遵守 JSON 协议；解析已尽量容错，失败时降级为直接回答。上线前请用 Pro 档实际问几类问题（简单问答、多方面比较、需要最新信息的问题）。
- 协调 Agent 若先写一段话再给 JSON，前 48 个字会被当作直接回答开始显示；随后识别到计划时停止显示并改为分派（已写出的开头会被综合回答覆盖）。
- 停止或 DO 重启时，已发出但结果未知的调用按该次预留保守结算（记为「待核对」），可能比实际用量高；这是为了保证不少扣。
- 最坏情况预留较大（约 12–22 万点）：额度低的成员会自动退回单 Agent，这是预期行为。
- 取消依赖同一 Durable Object 实例内的内存登记；DO 被重启后，旧运行的停止请求返回 `{ cancelled: false }`，该运行随 DO 重启中断并按待核对回收。
- 流中断后的「查询原请求」沿用原 180 秒等待窗口；多 Agent 运行可能更长，超出后需成员再点一次查询。
- 人工检查：管理页保存与校验提示；Pro 回复的过程区卡片（进行中、完成、失败、停止四种状态）、窄屏显示；停止按钮能中止子 Agent；引用角标与来源列表编号一致；Token 使用详情里只有一条记录。
