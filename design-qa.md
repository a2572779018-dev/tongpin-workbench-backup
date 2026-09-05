# 同频 AI 工作台设计验收

## 最新验收：2026-09-05 恢复黄白视觉

用户明确否定暗色方案。本轮恢复原来的暖白背景、柔黄按钮、深色文字和同频描边，
仅保留缩小后的同频金属 Logo、液态球与低强度浅色输入框光效。
未修改项目、对话、权限、额度与请求逻辑。

视觉源：`design-qa/ai-layout-20260905/05-final-desktop.png`。
本轮实景：`design-qa/ai-light-20260905/desktop.png`。
完整比较与检查见 [浅色恢复验收](design-qa/ai-light-20260905/report.md)。
3 个定向测试文件共 15 项通过，类型检查、生产构建与差异检查通过。

final result: passed

## 历史验收：2026-09-05 AI 暗色实验（已撤回）

本轮采用 AI 专属深灰、冷银和蓝紫视觉，保留待办与客户图的现有主题。
详细来源、许可、截图比较、修复项和交互复验见
[AI 金属视觉验收](design-qa/ai-metal-20260905/report.md)。

最新验证：68 个测试文件、376 项测试通过；类型检查、Web 构建和差异检查通过。
当前模型与额度服务仍未连接，页面不再使用下方历史演示记录中的虚构回复、点数或成果。
本次只完成本地视觉集成，没有上线或打包发布。最新视觉验收结论：passed。

以下保留历史交互验收记录；与本节不一致的阶段性演示描述不代表当前能力。

## 验收范围

- 设计基准：同频现有黄白黑视觉、用户提供的侧栏问题截图，以及已确认的三栏 AI 工作台方向。
- 实现页面：`src/pages/TongpinAIPage.tsx` 与 `src/features/tongpin-ai/`。
- 本轮状态：项目/普通对话分组、新建命名弹窗、项目菜单、重命名、删除确认、普通对话底部吸附、左下角账号额度入口。
- 最终交互复验视口：Codex 内置浏览器 `1023 × 933 px`。

## 对比证据

- 用户问题截图归一化：`design-qa/source-user-sidebar-bug-normalized.jpg`
- 旧问题与修正后同屏：`design-qa/sidebar-bug-fix-comparison.jpg`
- 收起后底部吸附同屏：`design-qa/sidebar-docked-comparison.jpg`
- 新对话命名弹窗：`design-qa/implementation-new-conversation-dialog.png`
- “是否新建项目”确认弹窗：`design-qa/implementation-project-create-confirmation.png`
- 项目操作菜单：`design-qa/implementation-project-context-menu.png`
- 删除确认弹窗：`design-qa/implementation-project-delete-confirmation.png`
- 项目菜单与删除确认并排：`design-qa/project-management-flow-comparison.jpg`
- AI 逐字回复中：`design-qa/implementation-ai-typewriter-midstream.png`
- 头像额度悬浮层：`design-qa/implementation-account-quota-hover.jpg`
- Token 使用详情：`design-qa/implementation-token-usage-dialog.jpg`

说明：内置浏览器导出的图像实际为 JPEG 编码；扩展名沿用采集文件名，像素尺寸与编码已用 `file`、`sips` 核验。

## 设计与逻辑检查

### 信息架构

- 成员主导航保持“我的任务 → 客户脉络图 → 同频 AI”。
- 成员端不显示管理员额度或开源底座对比；管理员额度继续受管理员角色保护。
- 项目与普通对话分组独立；项目对话只显示在所属项目下。
- 普通对话展开时位于项目列表后；收起时吸附在侧栏底部、账号入口上方。
- 账号头像位于 AI 侧栏左下角；悬浮显示额度摘要，点击进入 Token 使用详情。

### 项目与对话

- “新项目”先显示“是否新建项目？”并要求输入名称；普通/项目内新对话也先打开命名弹窗。取消、Esc 或点击遮罩不会写入记录。
- 项目创建后为空，不自动创建对话；项目内对话只有确认名称后才写入并聚焦输入框。
- 项目行支持右键，同时提供可见“…”菜单，包含“重命名”和危险色“删除项目”。
- 重命名预填原名称；保存后侧栏和项目页标题同步更新，不改变项目内对话。
- 删除项目必须二次确认。遵循安全语义：项目内对话移入普通对话，对话内容及成果不删除。
- 删除含对话项目后，当前对话继续可用、项目归属清空，普通对话计数同步增加。

### 对话、成果与额度

- 导航不会静默取消正在生成的回复；延迟回复仍写回原对话，不会强行打开到另一条对话。
- AI 新回复从思考状态进入逐字显示状态，并带 BB 机式闪烁光标；完成后才挂载成果卡。
- 新生成成果带有 `conversationId` 和可选 `projectId`，不再让所有对话共用同一个成果。
- 快速模式每次 12 点、深度模式每次 24 点；当前余额不足对应模式成本时禁用发送并给出一致提示。
- PPT 生成与图片生成仅位于输入框“+”菜单，Skill 数量来自实际 Skill 数据。
- 管理员额度示例接收者仅为成员，不再给老板角色分配成员 AI 额度。

### 视觉与可访问性

- 延续粗黑描边、轻投影、奶油黄与暖白主色；弹窗、菜单、危险操作均沿用同频视觉语言。
- 命名弹窗使用 `role="dialog"`，删除确认使用 `role="alertdialog"`；两者具备焦点圈定、Esc 关闭和明确标签。
- 项目菜单支持键盘方向键、Home、End 与 Esc；点击外部、滚动和窗口变化会关闭。
- 同屏检查确认：项目、普通对话、账号入口无重叠；弹窗未裁切；按钮、输入框和危险状态层级清楚。
- 浏览器控制台复验无错误或警告。

## 验证结果

- TypeScript：通过。
- Vitest：65 个测试文件、372 项测试通过。
- Web 生产构建：通过。
- `git diff --check`：通过。
- 当前阶段仍是本地前端交互；LibreChat、模型调用、持久化与服务端原子额度扣减尚未接入，本报告不将其视为已完成。

## 最终结论

passed
