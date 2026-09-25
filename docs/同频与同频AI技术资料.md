# 同频与同频 AI 技术资料

整理日期：2026-09-25

## 1. 项目位置

代码仓库：`/Users/sam/Documents/ChatGPT/个人/tongpin-workbench-git`

- 当前分支：`codex/ai-continuation-20260923`
- 当前版本：`0.1.49`
- 当前 HEAD：`99df17c56e631c5cb8082bfa11cb8e6c113e7c7f`
- 当前工作树：干净
- 当前代码不能等同于已完成生产部署；真实供应商、真实成员迁移、Mac/Windows 实机和生产回归仍需分别验收。

## 2. 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite |
| UI | CSS、Lucide、Phosphor、GSAP、Auto Animate、XYFlow |
| Markdown | react-markdown、remark-gfm、remark-math、KaTeX |
| 桌面端 | Electron 43 |
| 本地后端 | Node.js 24、Express 5、TypeScript |
| 本地 AI 数据库 | Node SQLite |
| 云端后端 | Cloudflare Workers |
| 云端数据库 | Durable Objects SQLite |
| 文件发布 | Cloudflare R2 |
| 实时通信 | WebSocket |
| AI 流式通信 | SSE / Streaming Response |
| 认证 | JWT、刷新令牌、bcrypt、邮箱验证码 |
| 密钥保护 | 服务端加密、Electron safeStorage |

主要依赖配置：`package.json`

## 3. 前端目录

入口：`src/App.tsx`

主要页面：

- `src/pages/MemberHome.tsx`：成员任务首页
- `src/pages/RelationshipMapPage.tsx`：客户脉络图
- `src/pages/TongpinAIPage.tsx`：同频 AI
- `src/pages/AdminConsole.tsx`：管理员后台
- `src/pages/BossDashboard.tsx`：老板端
- `src/pages/AuthPage.tsx`：登录、注册和验证

同频 AI 主要模块：`src/features/tongpin-ai/`

包含：

- 对话工作区、会话和项目
- AI 流式回复
- Markdown、表格、代码和公式
- 图片、视频和 PPT
- 视频参考图
- 额度和用量显示
- AI 人设
- Skill 菜单和 `@xxx` 技能提及
- Computer Use
- Harness 运行轨迹
- 工具调用状态
- 媒体展示、下载和恢复
- V2 会话存储客户端

核心文件：

- `src/features/tongpin-ai/ChatWorkspace.tsx`
- `src/features/tongpin-ai/TongpinAIWorkspaceV2.tsx`
- `src/features/tongpin-ai/MarkdownReply.tsx`
- `src/features/tongpin-ai/ChatMessageRow.tsx`
- `src/lib/aiRunStream.ts`

## 4. 本地后端

入口：`server/index.ts`

应用装配：`server/app.ts`

主要 API：

- `/api/auth`
- `/api/tasks`
- `/api/contacts`
- `/api/notifications`
- `/api/admin`
- `/api/boss`
- `/api/ai`
- `/api/admin/ai`
- `/api/ai/workspace`
- `/api/ai/workspace-v2`
- `/api/ai/persona`
- `/api/dify/tools/invoke`

AI 后端目录：`server/ai/`

关键模块：

- `service.ts`：AI 主服务、额度、请求账本、模型调用
- `provider.ts`：供应商协议和响应解析
- `providerStream.ts`：流式供应商响应
- `harness.ts`：业务档位、路由、工具计划和后台继续
- `dispatch.ts`：文本、图片、视频、PPT 和电脑操作分派
- `videoService.ts`：视频生成
- `imageProvider.ts`：图片生成
- `mediaTaskOrchestrator.ts`：媒体任务生命周期
- `workspace.ts`：旧版 AI 工作区
- `workspaceV2Store.ts`：V2 分实体存储
- `observabilityThresholds.ts`：耗时、成功率和告警阈值
- `difyEngine.ts`：Dify 适配层，目前未成为主聊天引擎

## 5. 云端后端和部署

Cloudflare Worker：`cloudflare/src/index.ts`

Durable Object 核心：`cloudflare/src/core.ts`

配置：`cloudflare/wrangler.jsonc`

生产链路：

```text
同频客户端
  ↓
https://notify.samhubs.com
  ↓
Cloudflare Worker
  ↓
TongpinCore Durable Object
  ↓
Durable Object SQLite
```

客户端配置在：`electron/app-config.json`

当前使用：

- Durable Object：`TONGPIN_CORE`
- Durable Object 类：`TongpinCore`
- Durable Object SQLite
- R2 桶：`tongpin-workbench-releases`
- WebSocket 实时通信
- Cloudflare Observability
- Cron 定时任务

当前通过 `idFromName("primary")` 使用核心 Durable Object。租户隔离依靠租户字段、服务端鉴权和查询条件实现，并不是每个租户一个独立数据库。

## 6. 普通同频数据存储

### 本地 Express 模式

默认数据文件：

```text
.data/tongpin.json
```

配置文件：`server/config.ts`

内容包括：

- 用户账号
- 任务
- 验证码摘要
- 刷新会话
- 通知
- 联系人
- 私信
- 老板工作报告
- LORA 链相关数据

### 云端生产模式

生产环境使用 Cloudflare Durable Object SQLite，不依赖成员电脑本地文件。

表结构定义：`cloudflare/src/schema.ts`

主要表：

- `users`
- `tasks`
- `notifications`
- `contacts`
- `direct_messages`
- `refresh_sessions`
- `verification_codes`
- `task_audit_events`
- LORA 相关表

## 7. 同频 AI 的本地存储

本地 AI SQLite：

```text
.data/tongpin.json.ai.sqlite
```

AI 密钥加密材料：

```text
.data/tongpin.json.ai-key
```

创建逻辑：`server/ai/node.ts`

AI 主要数据表：

- `ai_settings`：管理员 AI 配置
- `ai_quotas`：成员额度
- `ai_requests`：请求和账本
- `ai_request_snapshots`：请求快照
- `ai_run_events`：流式事件
- `ai_harness_runs`：Harness 运行记录
- `ai_harness_steps`：Harness 步骤
- `ai_usage`：用量记录
- `ai_assets`：图片、视频等资产
- `ai_asset_chunks`：资产分块
- `ai_video_jobs`：视频任务
- `ai_video_references`：视频参考图
- `ai_observability_events`：模型耗时、成功和失败
- `ai_observability_alerts`：告警
- V2 工作区实体、消息、草稿、项目和附件表

表结构和存储逻辑：`server/ai/storage.ts`

云端 Worker 使用相同的 AI 业务逻辑，但 SQL 连接的是 Durable Object SQLite，而不是本地 SQLite 文件。

## 8. Electron 桌面端存储

主进程：`electron/main.cjs`

桌面端数据目录由 Electron 的 `app.getPath("userData")` 决定。

主要保存：

- 加密登录会话
- safeStorage 加密凭据
- 客户脉络图本地加密绑定
- 更新失败标记
- 桌面端临时状态

客户脉络图使用独立的加密本地存储，不与普通任务数据混用。

## 9. 同频 AI 的运行逻辑

```text
用户发送消息
  ↓
前端预检：会话、附件、额度、重复请求
  ↓
服务端鉴权和额度预留
  ↓
Harness 选择业务档位和服务商
  ↓
模型文本响应或工具计划
  ↓
服务端校验工具计划
  ↓
图片、视频、PPT、搜索或电脑工具
  ↓
记录用量和运行事件
  ↓
SSE 增量返回
  ↓
前端 Markdown、媒体和工具状态渲染
  ↓
保存会话和成果
```

业务档位：

- 快速
- 标准
- 深度
- Pro

Harness 策略：

- `direct`
- `react`
- `plan_execute`

支持能力：

- 文本对话
- 视觉理解
- 联网搜索
- 图片生成
- 视频生成
- PPT 生成
- Computer Use

成员端原则上只看到统一业务档位，不直接接触供应商密钥。

## 10. 已存在或已完成本地验证的 AI 能力

- 多供应商 API Base URL 和密钥配置
- 供应商模型发现
- 业务档位到模型的路由抽象
- 成员额度和 token 用量记录
- 请求预留和重复扣费保护
- SSE 流式正文
- Markdown/GFM 表格
- 代码块复制
- 图片生成
- 视频生成
- 视频参考图片
- PPT 生成和导出
- 生成媒体在同一会话继续引用
- Harness 运行轨迹
- 工具授权和审批
- Computer Use 基础链路
- AI 人设
- 多会话并发
- 会话恢复
- V2 分实体消息存储
- 超过旧 8MiB 限制的本地 V2 纵切验证
- 管理员 AI 观测数据

## 11. 当前不能过度宣称的内容

以下内容不能仅凭本地测试称为生产已完成：

- 真实生产供应商的全部组合验收
- 真实成员账号 V2 迁移
- 生产 Cloudflare 部署后的完整回归
- Mac/Windows 打包实机全部验证
- OpenSquilla 官方运行时接入
- Dify 成为主聊天调度引擎
- LibreChat Agent/tool loop/MCP 的完整深层复用
- 所有富内容类型的完整生产链路
- 多租户“完全隔离”的生产级实机证明

## 12. 相关交接资料

- `docs/ai-handoff/01-开发阶段.md`：原 33 项任务台账
- `docs/ai-handoff/02-当前交接.md`：当前工作现场和阻塞
- `docs/ai-handoff/03-保护规则.md`：保护范围和不可执行事项
- `docs/ai-handoff/04-任务日志/`：每个工作包的详细记录
- `docs/ai-handoff/05-验收记录.md`：验收证据索引
- `docs/ai-handoff/06-架构与开源复用.md`：开源项目和架构复用说明
- `docs/ai-handoff/07-0.1.49交付核对表.md`：0.1.49 交付边界
- `docs/ai-handoff/08-交付对应关系与验收入口.md`：隔离验收入口和证据
- `README.md`：项目运行、部署和安全说明
- `docs/MACOS.md`：Mac 开发、打包和更新说明

## 13. 一句话总结

同频是一个 React + TypeScript 前端、Electron 桌面壳、Node/Express 本地后端、Cloudflare Worker + Durable Object SQLite 云端后端组成的内部协作系统。

同频 AI 是其服务端 AI 编排层：管理员配置供应商和业务档位，成员通过统一对话入口使用文本、图片、视频、PPT 和电脑操作能力；额度、密钥、请求账本和会话数据由服务端管理。
