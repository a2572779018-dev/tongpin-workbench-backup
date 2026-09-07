# Fleur — 用户购买导出组件

来源：用户从 Metalforge Character 页面购买并下载的 Fleur 导出包，2026-09-07 提供给同频项目使用。本目录复用该导出的造型、表情几何及 `character-runtime.js`，不是独立重新绘制的近似头像。

这是用户购买的导出内容，**不标记为 MIT 或其他开源许可证**。使用与分发以用户购买条款为准；不要将独立付费源码、原始压缩包或示例 `index.html` 作为公共资源发布。本目录仅作为同频应用内部组件打包，原导出包保留在仓库外。

```tsx
import { FleurCharacter, type FleurMood, type FleurSays } from "./FleurCharacter";

<FleurCharacter mood="thinking" says="question" paused={false} followPointer framing="compact" impressionPlayback="hold" interactive={false} className="my-avatar" />
```

`mood` 与 `says` 为固定枚举；`says="none"` 不留额外头顶空白。显式 `mood` 且未指定 `says` 时默认不带符号；两者都省略时保留购买导出的 confused / question。组件透明，容器决定尺寸。默认 `interactive=false` 不拦截触控滚动。

同频适配：修复 blush filter ID 作用域、旧 RAF 闭包、缺失类型导出；加入 `paused`、离屏/后台/减少动态效果自动暂停，暂停前绘制一帧，恢复时重置时间采样，只累计可见运行时间，绘制预算为 30 帧/秒。截止时钟保持累计相位，并在 0.25ms 近邻内重新对齐真实显示时钟，避免时间戳圆整/微漂移造成规律性掉帧或短长帧交替；动画收到实际帧间隔，长停顿不补画大量帧。每帧直接更新原 SVG 节点，不驱动 React state，不使用 WebGL。为保证表情不被裁掉，`says` 非 none 时仍按原引擎印记尺寸保留空间。

`followPointer` 默认关闭。启用后仅精细鼠标、可见且运行动效时跟随；鼠标偏航最大 14°、俯仰最大 10°。引擎保留眼睛形状与任务表情时序，只减弱会抵消鼠标方向的基础转头/侧倾：完全跟随时合成偏航不超过 18°、俯仰不超过 13°、侧倾不超过 6°。不移动 SVG 容器或重置任务表情；spin/tumble 保留原旋转，暂不叠加鼠标跟随。指针移动/按下事件仅记坐标，30fps 绘制中平滑推进，鼠标静止或点击后保持朝向。离开窗口/失焦时平滑回正，隐藏/暂停时清空跟随。不拦截点击、不捕获指针、不阻止滚动。每个跟随绘制开始前仅读取一次最新 SVG 外框，以 viewBox 原点与实际缩放计算花头中心，排除顶部印记空白与布局切换影响，不在指针事件里触发布局。角色切换只在内存中复用 1.5 秒内的单个最新指针坐标，重新计算新角色朝向，不保存轨迹或持久化坐标。

暂停/减少动态效果时，单独生成静止表情快照并显示完整符号，不推进实时动画的时钟。

小尺寸工作台头像可传 `framing="compact"`，只为顶部符号与轻微侧倾保留定向空间，避免把所有方向都扩成最大正方形。默认 `safe` 保留完整旋转余量；spin/tumble 即使指定 compact 也回退 safe。`impressionPlayback="hold"` 会立即显示成形印记并稳定保留，不再经历原导出约 5 秒的成形/收回循环。默认 cycle 仍保留原动画。持有印记的几何计算按固定表情缓存，不在每一帧重新生成。

`character-runtime.d.ts` 为同频补齐的严格边界声明；未修改项目 TypeScript 检查设置，也未加入 `ts-nocheck`。
