# Fleur — 用户购买导出组件

来源：用户从 Metalforge Character 页面购买并下载的 Fleur 导出包，2026-09-07 提供给同频项目使用。本目录复用该导出的造型、表情几何及 `character-runtime.js`，不是独立重新绘制的近似头像。

这是用户购买的导出内容，**不标记为 MIT 或其他开源许可证**。使用与分发以用户购买条款为准；不要将独立付费源码、原始压缩包或示例 `index.html` 作为公共资源发布。本目录仅作为同频应用内部组件打包，原导出包保留在仓库外。

```tsx
import { FleurCharacter, type FleurMood, type FleurSays } from "./FleurCharacter";

<FleurCharacter mood="thinking" says="question" paused={false} followPointer framing="compact" impressionPlayback="hold" interactive={false} className="my-avatar" />
```

`mood` 与 `says` 为固定枚举；`says="none"` 不留额外头顶空白。显式 `mood` 且未指定 `says` 时默认不带符号；两者都省略时保留购买导出的 confused / question。组件透明，容器决定尺寸。默认 `interactive=false` 不拦截触控滚动。

同频适配：修复 blush filter ID 作用域、旧 RAF 闭包、缺失类型导出；加入 `paused`、离屏/后台/减少动态效果自动暂停，暂停前绘制一帧，恢复时重置时间采样，只累计可见运行时间，最多 30 帧/秒。每帧直接更新原 SVG 节点，不驱动 React state，不使用 WebGL。为保证表情不被裁掉，`says` 非 none 时仍按原引擎印记尺寸保留空间。

`followPointer` 默认关闭。启用后仅精细鼠标、可见且运行动效时跟随；最大额外偏航 7°、俯仰 5°，只复用引擎头部与眼睛投影，不移动 SVG 容器或重置任务表情。指针事件仅更新引用，30fps 绘制中平滑推进，停止移动后回中。离开窗口、失焦、隐藏或暂停会清除跟随；不拦截点击、不捕获指针、不阻止滚动。几何尺寸在绘制前按需缓存读取，不在鼠标移动事件里触发布局。

暂停/减少动态效果时，单独生成静止表情快照并显示完整符号，不推进实时动画的时钟。

小尺寸工作台头像可传 `framing="compact"`，只为顶部符号与轻微侧倾保留定向空间，避免把所有方向都扩成最大正方形。默认 `safe` 保留完整旋转余量；spin/tumble 即使指定 compact 也回退 safe。`impressionPlayback="hold"` 会立即显示成形印记并稳定保留，不再经历原导出约 5 秒的成形/收回循环。默认 cycle 仍保留原动画。持有印记的几何计算按固定表情缓存，不在每一帧重新生成。

`character-runtime.d.ts` 为同频补齐的严格边界声明；未修改项目 TypeScript 检查设置，也未加入 `ts-nocheck`。
