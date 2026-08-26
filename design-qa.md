# LORA 链驾驶舱视觉 QA

## 对照

- 参考：用户提供的 1440×900 实际界面截图。
- 实现：`output/lora-dashboard-1440x900.png` 与 `output/lora-dashboard-1280x720.png`。

## 检查结果

- 配色：页面使用纯黄色 `#FFD84D` 背景与纯白色 `#FFFDF7` 卡片；深墨色仅用于文字与边框，不使用灰色蒙层。
- 层级：KPI、图表、表格和状态区通过黄色填充、白色卡片、边框与线型区分，无渐变、透明滤镜或灰色卡片。
- 文案：删除重复的时区、区间和数据源解释，只保留指标名、数值、必要状态及明细字段。
- 信息密度：六项 KPI、三张图、两张明细表和底部健康状态均保留。
- 适配：1280×720 与 1440×900 均无横向溢出；主要图表在首屏；表格内部滚动。
- 数据：完整指标显示最终值；首轮回填中的交易、活跃地址、Gas 与大额统计显示已采集下限值并加 `+`，不再整块隐藏为“同步中”。
- 运行：35 个测试文件 176 项通过，前后端类型检查、Web/API 构建与 Cloudflare dry-run 通过。

## 遗留

- 今日新增链上地址在缺少当日零点快照时仍显示“无日基线”，避免伪造数字。

final result: passed

---

# 已合作客户脉络图与任务刷新 QA

## 视觉证据

- 原始关系图参考：`/var/folders/64/2mdd5r1x1zn8rwnnf90vx3mc0000gn/T/codex-clipboard-f36846e2-5936-4dbd-84ca-87a5ea3b3052.png`。
- 连线问题标注：`/var/folders/64/2mdd5r1x1zn8rwnnf90vx3mc0000gn/T/codex-clipboard-22729394-d74e-41d8-8b9a-5f2f10874ad4.png`。
- 金字塔第二层重叠标注：`/var/folders/64/2mdd5r1x1zn8rwnnf90vx3mc0000gn/T/codex-clipboard-102f5de5-de51-4537-97cb-76d4774e9b31.png`。
- 头像变形标注：`/var/folders/64/2mdd5r1x1zn8rwnnf90vx3mc0000gn/T/codex-clipboard-1664b22a-7b42-42da-b360-365eca657d38.png`。
- 头像黑色错位投影标注：`/var/folders/64/2mdd5r1x1zn8rwnnf90vx3mc0000gn/T/codex-clipboard-68199e41-3287-43f5-83df-2115fc436f9e.png`。
- 横向完整预览：`output/customer-map-horizontal-trunk-1440x900.png`。
- 展开唐婕预览：`output/customer-map-expanded-trunk-1440x900.png`。
- 金字塔预览：`output/customer-map-pyramid-1440x900.png`。
- 金字塔修复预览：`output/customer-map-pyramid-clean-tongpin-1440x900.png`。
- 1280×720 预览：`output/customer-map-horizontal-1280x720.png`。
- 原版灰色皮肤：`output/customer-map-original-1440x900.png`。
- 参考与实现同屏对照：`output/customer-map-reference-comparison.png`、`output/customer-map-trunk-comparison.png`。
- 金字塔修复前后同屏对照：`output/customer-map-pyramid-before-after.png`。
- 头像无投影完整预览：`output/customer-avatar-no-shadow-tongpin-1440x900.jpg`；局部前后对照：`output/customer-avatar-shadow-before-after.png`。
- 客户状态参考：`/var/folders/64/2mdd5r1x1zn8rwnnf90vx3mc0000gn/T/codex-clipboard-c336f902-dcf2-4640-9c9a-96be0ce0f903.png`；完整预览：`output/customer-status-lines-clean-tongpin-1440x900.jpg`；编辑预览：`output/customer-status-edit-form-1440x900.jpg`；图例对照：`output/customer-status-legend-before-after.png`。

## 视觉检查

- 默认横向树以一条中心主干统一分叉，消除了首尾客户的大弧线和交叉绕线；下级客户沿父客户右侧继续使用相同的主干分叉规则。
- 折叠分支显示未展开人数；展开后人数消失，只保留小型收起箭头。
- 同频皮肤按层级使用黄色、蓝色、粉色、绿色；原版灰色皮肤未被层级颜色覆盖。
- 顶部搜索、新增客户、导入、导出、换肤和隐私按钮在 1280×720、1440×900 均不重叠，无横向溢出。
- 横向和金字塔两种自动排列均完整显示；长层级留在画布内缩放，不增加页面滚动。
- 金字塔按客户子树独立排位：单个下级垂直对齐，多个下级只在自己的上级下方分叉，不再把不同上级的第二层客户合并到同一条横线上。
- 上传头像固定为等宽等高的正方形裁切区，再使用圆形遮罩与 `object-fit: cover` 居中裁切，不会被节点布局拉成长扁形。
- 实际上传头像移除节点的错位黑色投影，默认字母头像、中心头像和展开按钮继续保留原有层次；悬停、选中和搜索命中状态也不会重新加回头像投影。
- 图例使用“已合作客户 / 待合作客户”；公共主干保持实线，仅客户末端线段按合作状态切换实线或虚线。

## 交互检查

- 点击折叠客户可展开并聚焦其下级客户；唐婕展开后显示罗可、徐妍两个蓝色二级客户且不再显示数字 2。
- 搜索折叠分支中的宋晴会自动展开祖先路径并显示 1 个结果。
- 新增客户表单保留手机号、微信号、标签和合作记录，支持选择现有客户作为上级或暂不连接。
- 拖动未连接客户到现有客户附近可建立连接；调整已有客户主连接前必须确认。
- 任务板实时同步和新建任务后的刷新改为保留现有卡片的静默更新，仅首次加载显示骨架屏，避免整列卡片闪烁。
- 客户详情编辑可在“已合作客户 / 待合作客户”之间切换，保存后详情文本和图中线型即时同步；旧数据默认迁移为“已合作客户”，状态继续使用成员隔离的本地加密存储。

## 验证结果

- TypeScript 类型检查通过。
- 53 个测试文件、252 项测试通过；新增横向/金字塔布局、分支连线、头像圆形裁切、头像无投影、客户合作状态实时线型和任务静默刷新回归测试。
- Renderer 和服务端生产构建通过。
- 当前仅提供本地预览，未修改版本号、未制作安装包、未发布更新。

final result: passed

---

# 人物关系爆炸双风格集成 QA

## 视觉证据

- 原关系程序当前源码：`output/relationship-current-source-1440x1024.png`。
- 原源码与同频适配并排对照：`output/relationship-qa-current-source-side-by-side.png`。
- 同频风格最终预览：`output/relationship-final-tongpin-1440x900.png`。
- 同频风格小屏预览：`output/relationship-final-tongpin-1280x720.png`。
- 原版风格最终预览：`output/relationship-final-original-1440x900.png`。
- 同频主导航内嵌状态：`output/relationship-preview-embedded-1280x590-after-fit.png`。

## 视觉检查

- 默认使用同频黄色、米白和黑色体系；节点层级继续用同频任务板已有等级色，未套灰色滤镜。
- 右上角衣服按钮可在同频风格与原版冷灰黏土风格之间切换，按钮图标、圆角、描边和阴影均沿用对应主题。
- 1440×900、1280×720 和主导航内嵌高度均完整显示图谱、筛选、缩放、图例和布局按钮；无横向或页面纵向溢出。
- 长工具栏在 1280 宽度仍保持单行可用，人物节点、关系曲线和控制区没有裁切。

## 交互与权限检查

- 关系入口仅 member 可见；boss/admin 保持原页面和功能，不加载关系模块。
- 同频 `AppShell`、铃铛、Socket 实时通知和强提醒始终位于关系模块外层，切换页面不会中断。
- 两套主题在本机记忆；刷新后保持上次选择。
- 新增人物、人物详情、新增/编辑/删除关系、搜索、筛选、布局切换、导入、导出、报告和隐私模式均保留。
- 键盘打开林澜快捷卡后焦点落到“查看完整详情”；关闭详情后回到原按钮；取消新增关系后回到快捷卡新增按钮。
- Shadow DOM 内的焦点查询、GSAP 节点查询和自定义光标均限定在关系模块范围；关系模块异常由局部错误边界接住，不卸载通知外壳。
- 关系数据按当前已验证成员账号写入系统加密存储，不在生产 Renderer 的 localStorage 保存正文。
- 隐私关系数据导出会重编号人物，并移除姓名、原始 ID、联系方式、头像、分组、标签、自由文本备注、精确指标、坐标和全部真实连线；隐私报告不复用用户输入，也不保留小团队精确计数。

## 构建与回归

- TypeScript 类型检查通过。
- 49 个测试文件、231 项测试全部通过。
- Renderer 生产构建与服务端生产构建通过。
- 正式 Renderer 只生成 `index.html`，预览专用 `relationship.html` 不进入生产包。
- 最终预览浏览器无 warning/error；`git diff --check` 通过。

final result: passed

---

# 登录页视觉跟随预览 QA

## 视觉证据

- 现有登录页对照：`artifacts/login-preview/reference-current-login.png`，1269×714。
- 新版默认状态：`artifacts/login-preview/preview-login-motion.png`，1269×714。
- 密码隐私状态：`artifacts/login-preview/preview-password-privacy.png`，1269×714。
- 同屏对照：`artifacts/login-preview/login-visual-comparison.png`。
- 密码动作对照：`artifacts/login-preview/password-visual-comparison.png`。
- 响应式检查：`artifacts/login-preview/preview-900x900.png` 与 `artifacts/login-preview/preview-520x900.png`。

## 视觉检查

- 保留原登录页双栏、品牌标题、工作日票据、右侧表单、字号、边框和硬阴影；只在右侧邮箱输入框上方增加极简 Bot。
- Bot 使用两张透明 PNG 实体素材：默认姿势双手趴住邮箱框上沿，密码姿势双手抬起并完整遮住双眼；沿用黄色、米白、粉色和墨色。
- 不显示气泡、状态解释、隐私图标或额外小字；具体错误仍由原表单呈现。
- 1269×714、900×900、520×900 均无页面横向溢出；账号下拉未被遮挡或裁剪。

## 交互检查

- 鼠标从左侧移到右侧时，Bot 以双手为支点轻微转头，眼睛跟随鼠标；不再上下悬浮。触屏和 `prefers-reduced-motion` 路径会关闭跟随动画。
- 邮箱获得焦点并输入完整地址后，提示切换为“邮箱格式没问题”。
- 密码框获得焦点后，Bot 双手遮眼；离开密码框后恢复趴在邮箱框上的默认姿势。显示密码按钮保持原功能和焦点语义。
- 密码姿势在第二轮视觉复核中下移 15.2px，机身下沿已与邮箱框上沿贴合，不再呈现悬空间隔；默认姿势位置不变。
- 历史账号下拉可打开并显示空状态；注册、返回登录和找回密码页面均可进入。
- 登录提交、账号安全存储、会话恢复、注册验证和找回密码逻辑未改动。
- 生产构建预览无浏览器 warning/error。

## 验证结果

- TypeScript 类型检查通过。
- 43 个测试文件、206 项测试全部通过。
- Vite 生产构建通过。
- 视觉预览通过后进入 0.1.23 正式发布流程。

final result: passed

---

# 快捷待办等级配色与热角行为 QA

## 视觉证据

- 源视觉真值：`/var/folders/64/2mdd5r1x1zn8rwnnf90vx3mc0000gn/T/codex-clipboard-25656e7a-5989-443e-97c9-4a0984a7499d.png`，3008×2084。
- 源快捷窗裁剪：`artifacts/quick-task-priority-source-crop.png`，从原图 760×1000 区域归一化为 380×500。
- 实现截图：`artifacts/quick-task-yellow-row-preview.png`，Electron CSS 视口 380×500，截图密度 1×。
- 并排对照：`artifacts/quick-task-yellow-row-comparison.png`，776×500。
- 状态：P2 默认选中；预览数据覆盖 P0 至 P4，P4 为已完成状态。

## 视觉检查

- 任务卡片：P0 红、P1 粉、P2 黄、P3 蓝、P4 灰；已完成任务保持绿色卡片，等级标签继续显示其等级色。
- 等级按钮：P0 至 P4 恢复统一浅黄色，当前选中项为黑底白字；任务卡片继续按等级分色。
- 字体、间距、窗口尺寸、圆角、阴影、图标、按钮位置和既有文案均未改变。
- “按轻重缓急”未重新加入；无新增解释文字、渐变或横向溢出。
- 380×500 完整视图中创建区、等级按钮、任务列表和底部操作均保持可见，长列表继续在卡片内部滚动。

## 交互检查

- 点击 P0 后新建测试待办，新增卡片正确显示为 P0 红色并进入列表。
- 刷新预览后 fixture 状态正确恢复；页面无浏览器脚本错误。
- 黄色热角、快捷窗、Dock 与“打开完整同频”的激活路径由纯策略测试覆盖：热角只开快捷窗，快捷窗内激活不拉起主窗，Dock 仍可恢复主窗。
- Windows 使用可用桌面区域定位热角，底部、左侧或右侧任务栏都不会遮挡黄色小角。
- 正式发布前保留一次打包后 macOS 实机热角回归作为发布门槛。

## 比较历史

- 第 1 次：修复全部黄色后，P0 至 P4 的按钮、卡片和标签已与主任务板颜色一致；未发现 P0、P1 或 P2 视觉问题。
- 第 2 次：修复热角激活边界，避免快捷窗聚焦状态长期阻止 Dock 打开主窗；视觉未受影响。
- 第 3 次：按确认稿将横排等级按钮恢复为统一黄色和黑色选中态，重新以 380×500 截图并排复核；任务卡片继续保留五档等级色，无 P0、P1 或 P2 视觉问题。

final result: passed

---

# 右下角快捷待办视觉 QA

## 视觉证据

- 源视觉真值：`/Users/sam/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_x1df3i4xrg3822_ca3f/msg/video/2026-08/c3763c323ccaa7adf09b0de6149a7ef3.mp4`
- 源弹窗帧：`/tmp/tongpin-corner-video.HFJNjG/key-5.2.jpg`，720×1280；手机拍摄的 Quick Note 打开态，密度未知。
- 源热角裁剪：`output/hot-corner-preview/reference-corner-160.png`，160×160。
- 实现弹窗：`output/hot-corner-preview/quick-task-panel-380x500.png`，380×500；Electron CSS 视口 380×500，截图密度 1×。
- 实现热角裁剪：`output/hot-corner-preview/quick-corner-240.png`，240×240；来自 3420×2214 桌面截图的右下角裁剪。
- 状态：源与实现均为右下角入口已出现、点击后浮窗打开；实现内容按需求替换为今日待办。
- 归一化：源视频存在透视、拍摄缩放和未知像素密度，因此不做像素级缩放对齐；按相同交互状态比较窗口占位、锚点、层级和出现方式。

## 完整视图比较

- 源与实现都无遮罩，浮窗固定在右下角并独立覆盖桌面内容。
- 源 Quick Note 窗口更大；实现采用用户指定的小尺寸 380×500，不占用过多桌面，属于明确的产品约束而非偏差。
- 实现保留圆角、浅色表面、清晰阴影和即时聚焦输入，层级与参考一致。

## 聚焦区域比较

- 热角入口单独裁剪对比：参考约 32–40px 浅色圆角角标；实现为 42px 黄底圆角角标，锚点、显隐占位与点击目标一致，颜色沿用同频黄色品牌色。
- 弹窗内容单独检查：标题、输入、优先级、任务列表、滚动条、关闭和打开完整同频均完整可见；卡片内部滚动，不扩大窗口。

## 必查项

- 字体与层级：沿用 Space Grotesk、DM Mono 和系统中文回退；标题、日期、任务和辅助信息权重清楚，无异常换行。
- 间距与节奏：380×500 内头部、创建区、列表和底部操作分区稳定；无横向溢出，长列表只在卡片内部滚动。
- 色彩与令牌：沿用完整任务板的 P0 红、P1 粉、P2 黄、P3 蓝、P4 灰与完成态绿色；无渐变。
- 图标与资源：入口、待办、完成、关闭、添加均使用 Lucide 图标；无手绘 SVG、字符图标或占位图。
- 文案与内容：只保留新建待办、优先级、待完成数量和任务标题，没有大段说明小字。

## 交互验收

- P0 新建待办可提交，并立即按优先级进入列表顶部。
- 完成待办后自动移至列表底部，待完成数量同步减少。
- 鼠标滚轮可浏览全部今日待办，底部按钮保持固定。
- 关闭按钮可隐藏小窗；热角命中、150ms 停留、离开收起和多显示器边界由纯策略测试覆盖。
- Electron 预览控制台和终端未出现渲染错误。

## 比较历史

- 第 1 次：同一交互状态对照未发现可执行的 P0、P1 或 P2 视觉问题；未因 QA 结果修改视觉实现。

## 遗留

- 参考视频为手机透视拍摄，无法做精确的字体与像素密度一比一测量；该限制不影响热角位置、窗口层级和交互节奏判断。

final result: passed
