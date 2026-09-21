# AI 管理与能力审计（2026-09-21）

范围：35 项总清单中的原 17 项的 9、10、11、12、13、16，以及后续 6 项的 1、2、3（新加的静默调度与生图工具计划问题由其他任务审查）。本文件记录代码与自动化验证，不代表已部署或已做付费服务商验收。

## 本轮新增 1–3：已实现

- 后台分为「服务与模型 / 生成与搜索 / 成员额度 / 运行监控」四个入口。切换入口保留未保存输入；监控只在该页可见时每 15 秒刷新。
- 新版模型配置只出现快速、标准、深度、Pro 四个档位。旧快速/深度独立编辑入口已移除；必要的历史客户端密钥与媒体配置放入折叠的旧版兼容区域。
- 每档文字、图片、视频模型均为可直接点击的可搜索列表；不再依赖浏览器 datalist 的键入触发。无列表时会尝试读取所选服务的模型；输入关键字可筛选，键盘方向键/Enter/Escape 可操作。
- 读取模型使用当前未保存的地址和新密钥；更改地址但没填新密钥会给出明确提示。已保存地址使用服务端保存的密钥。旧请求在地址/密钥已变更后不会把过期模型列表写回。
- 服务标识改为应用生成且固定，避免输入时组件 key 变化导致焦点丢失；档位引用中的服务不能直接删除。保存后逐服务校验，单个服务失败会保留已经成功保存的状态且不会假报全部验证通过。
- 主要代码：`AdminAiQuotaPanel.tsx`、`AdminAiHarnessSettings.tsx`、`AdminAiModelSelect.tsx`、`adminAiModels.ts`、`AdminAiProviderSettings.tsx`、`AdminAiVideoSettings.tsx`。

## 原 9：租户数据、模型、权限隔离——基础已实现，完整运营验收未完成

- `server/ai/tenant.ts` 只从服务端认证主体读取租户字段，拒绝冲突/无效租户标识，忽略客户端伪造租户 Header。
- `AiStore` 对配置、请求、额度、账本、媒体、Harness、监控按租户隔离；persona/workspace 同样按租户与用户读取。非默认租户的存储键可区分相同用户/请求 ID。
- Express / Worker AI 路由均将 service 绑定到认证主体租户；管理员改成员额度先检查同租户成员；成员不能访问管理员接口。
- 自动化覆盖同 ID 的跨租户 workspace/persona、usage、Harness、视频配置/素材/任务/结算，以及服务商幂等键。
- 限制：旧公司安装使用 `default` 租户；这不等同于已经完成组织注册、管理员归属管理和两个真实组织的线上验收。前端媒体/会话缓存以账号 ID 为边界，完整多租户产品若允许同一账号在组织间切换，仍需将租户纳入客户端缓存 scope。

## 原 10：监控——真实终态指标与后台告警已实现，全链路实时仍有边界

- `AiService` 请求结算、`AiVideoService` 视频结算写入真实耗时、成功/失败、稳定错误码；planning 与 execution 分开统计，不记录正文、密钥或原始服务商响应。
- 后台查询最近 60 分钟的请求数、成功/失败数、成功率、错误率、平均/最大耗时、错误码，并保存告警确认/恢复历史。
- 本轮补齐错误率显示；无请求时成功率与延迟显示「—」，不会把无数据解释为 0% 成功。
- 当前阈值：至少 4 次请求且错误率 >=50%；至少 3 次请求全部失败；延迟最少 3 个样本，文本/规划 60 秒预警、120 秒严重，图像执行 3/6 分钟，视频执行 15/30 分钟。阈值集中于 `server/ai/observabilityThresholds.ts`。
- 本轮修复正常多分钟视频套用文本阈值而误报严重超时的问题；告警累计次数使用同一能力阈值，正常媒体样本不会增加命中次数。自动化覆盖边界时间、规划/执行分离和告警严重程度。
- 已审查主代理修正：视频结算用 `job.status === "completed"` 判断成功；人工确认扣费但产物仍未验证不再记为交付成功。
- 限制：这是每 15 秒刷新的后台告警，未包含邮件/短信/外部通知；没有第一 Token 延迟、运行中队列长度、每次网络跳转的分布式 tracing。不能宣称完整 APM。

## 原 11：业务档位抽象——服务端路由已实现，视频协议范围明确

- 每档有文字服务/模型/协议/输出上限/思考强度和图片、视频各自服务/模型。成员发送统一 tier，服务端解析对应路由、权限和能力，不接受任意供应商地址或密钥。
- 文字支持 Chat Completions / Responses，图片使用 Images 兼容服务；视频仅执行已接入 75api 协议的已验证模型，不能宣称任何视频 API 填地址就通用。
- 本轮恢复视频的具体模型选择属于用户明确要求的媒体参数选择，受当前档位服务的验证模型范围约束；不影响文字档位统一。
- 验证包含模型列表绑定密钥、改密钥失效、跨 provider 媒体路由、收费生成审批绑定和无效视频协议拒绝。

## 原 12：自动模型发现——已实现（依赖供应商 /models）

- 新建或修改服务无需先保存即可查询真实 `/models`，读取不会生成内容。
- 本轮补齐可直接展开的搜索下拉、当前草稿地址/密钥、空列表/失败提示、旧列表失效及并发响应保护。
- 供应商未提供 `/models`、密钥无模型权限或域名未获服务端允许时会明确失败，不能伪造选项或认为列表可见即所有能力生成成功。

## 原 13：基础功能 / Skill / Hub——已分类，Hub 是有限模板

- 能力中心分基础能力、Skill 和 Hub；6 类基础能力、6 个内置 Skill、3 个已审核工作流模板。
- Skill 改变任务指令，Hub 由确定步骤模板与 workflowId 进入请求；Harness 保存节点状态，未执行步骤不会标为已完成；`@xxx` 入口由另一子任务验收。
- Hub 并非 Dify Marketplace 插件安装，也不是任意拖拽编排器。基础能力卡片是入口说明，执行仍受真实服务、额度与平台权限限制。

## 原 16：性格库——37 个可持久化预设已接入，非整个外部仓库的自动同步

- `personaPresets.ts` 有 37 个按日常/工作/思考/创作分类的预设，PersonaSetup 支持检索、选择、修改自定义性格。
- 选择会写入每成员 persona.profile 的 tone/customStyle；服务端每次聊天读取 persona，传入 providerBody 的 chatInstructions；不是只改变界面标签。
- 来源在 THIRD_PARTY_NOTICES 中登记 MIT 的 awesome-ai-persona-skills，当前是人工改写目录；未复制真实人物身份宣称，未把第三方人设当权限。
- 限制：未实现整个上游仓库实时同步，也未对 37 个性格逐一做真实付费模型对话的差异性验收。

## 已运行验证

- `npx vitest run src/features/tongpin-ai/adminAiModels.test.ts src/features/tongpin-ai/adminAiForms.test.ts src/features/tongpin-ai/AdminAiObservability.test.ts server/ai/tenantIsolation.test.ts server/ai/harness.test.ts src/features/tongpin-ai/personaPresets.test.ts src/features/tongpin-ai/capabilityCatalog.test.ts server/ai/persona.test.ts`：8 个文件，136 个测试通过。
- `npm run typecheck`：通过。
- `npm run build:web`：通过（现存 downloadFeedback 动态/静态重复引入 warning，不影响构建）。
- `server/ai/observabilityThresholds.test.ts` + Harness/迁移测试：37 项通过。另新增 `serviceBaselineReview.test.ts` 的 4 项通过：仅配置 Harness 后保存能力定价、Responses 搜索档位与兼容文字协议解耦、异步保存时密钥变更拒绝、正确媒体服务探测和禁用能力不被旧配置重新开启。
- 本报告没有计入尚未运行的生产 GUI 验收、付费生成、部署或 Windows 更新。
