/**
 * A deliberately narrow, deterministic classification of a member's own
 * creation command. Both the composer and the server's Send-grant gate use
 * this exact rule; model text must never be passed here as consent.
 */
export type NaturalGenerationIntent = "image" | "video" | "ppt";

const REQUEST_PREFIX = "(?:(?:请|麻烦|劳驾|帮我|给我|替我|请你|请帮我|可以帮我|能帮我|我想要?|我要|我需要你(?:帮我)?|想请你|直接|立即|马上)\\s*)*";
const DIRECT_GENERATION = new RegExp(`^${REQUEST_PREFIX}(?:生成|制作|创建|做|画|绘制|设计|产出|出)\\s*(.+)$`, "iu");
const TRANSFORM_GENERATION = new RegExp(`^${REQUEST_PREFIX}(?:把|将|用|根据|基于|参考)\\s*.+?\\s*(?:生成|制作成?|设计成?|绘制成?|做(?:成|为|一份|一个)?|转换成|转成|改成|整理成)\\s*(.+)$`, "iu");
const ENGLISH_GENERATION = /^(?:(?:please|help me(?: to)?|i (?:want|need)(?: you)? to|could you please|can you please)\s+)*(?:create|generate|make|design|draw|produce)\s+(.+)$/iu;
const ENGLISH_TRANSFORM_GENERATION = /^(?:(?:please|help me(?: to)?|could you please|can you please)\s+)*(?:turn|convert|transform)\s+.+?\s+(?:into|to)\s+(.+)$/iu;
const NEGATED_ACTION = /(?:不要|别|先不|先别|暂不|不想|不需要|不用|无需|禁止|取消|停止)\s*(?:你)?\s*(?:帮我|给我|为我)?\s*(?:生成|制作|创建|做|画|绘制|设计|产出|出)/u;
const ENGLISH_NEGATED_ACTION = /\b(?:do not|don't|dont|never|no need to|stop|cancel)\s+(?:create|generate|make|design|draw|produce)\b/iu;

/** Remove only the explicitly selected, matching @ tool from planner input. */
export function withoutLeadingMediaMention(text: string, intent: "image" | "video"): string {
  return text.trim().replace(new RegExp(`^@${intent}(?=$|[\\s，,。！？:：])\\s*`, "iu"), "").trim();
}

export function naturalGenerationIntent(text: string): NaturalGenerationIntent | undefined {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 12_000) return undefined;
  // A brief factual preface may identify a reference ("这是 logo，帮我生成视频").
  // Do not scan arbitrary later sentences for an action; only this narrow form
  // and a direct command can carry a paid Send grant.
  const command = normalized.replace(/^(?:这是|这个是|这张是|这段是|上面是|刚才是|附件是|这里是).{0,80}?[，,。;；]\s*/u, "");
  if (/[?？]/u.test(command) || /(?:可以吗|行吗|能否|可不可以|好吗)[。.!！]?$/u.test(command)
    || NEGATED_ACTION.test(command) || ENGLISH_NEGATED_ACTION.test(command)) return undefined;
  const match = DIRECT_GENERATION.exec(command) ?? TRANSFORM_GENERATION.exec(command)
    ?? ENGLISH_GENERATION.exec(command) ?? ENGLISH_TRANSFORM_GENERATION.exec(command);
  const target = match?.[1]?.trim();
  if (!target || /^的/u.test(target)) return undefined;

  // These phrases describe or diagnose generation instead of asking to execute it.
  if (/(?:为什么|为何|怎么|如何|不能|无法|不了|失败|报错|错误|按钮|功能|接口|费用|价格|额度)|\b(?:why|how|error|failed|failure|button|feature|pricing|cost)\b/iu.test(target)) return undefined;
  if (/(?:视频|短片|动画|图片|图像|海报|PPT|PPTX|演示文稿|幻灯片)\s*(?:的)?\s*(?:提示词|脚本|文案|分镜|大纲|教程|方法|方案|流程)\s*[.!！。]*$/iu.test(target)
    || /\b(?:video|image|picture|presentation)\s+(?:prompt|script|storyboard|outline|tutorial|workflow)\b\s*[!.]*$/iu.test(target)) return undefined;
  if (/^(?:(?:一|两|几|\d+)\s*(?:个|份|段|张)\s*)?(?:视频|短片|动画|图片|图像|海报|PPT|PPTX|演示文稿|幻灯片)\s*(?:的)?\s*(?:提示词|脚本|文案|分镜|大纲|教程|方法|方案|流程)(?=$|[\s，,。;；.!！])/iu.test(target)
    || /^(?:(?:a|an|the)\s+)?(?:video|image|picture|presentation)\s+(?:prompt|script|storyboard|outline|tutorial|workflow)\b/iu.test(target)) return undefined;

  // A video thumbnail/cover is an image request, never a video grant.
  if (/(?:视频|PPT|PPTX|演示文稿).{0,6}(?:封面图?|配图|缩略图|海报)/iu.test(target)
    || /\b(?:video|presentation|slides?).{0,16}(?:cover|thumbnail|poster|image)\b/iu.test(target)
    || /\b(?:thumbnail|cover image)\b/iu.test(target)) return "image";
  if (/(?:PPTX?|PowerPoint|演示文稿|幻灯片|演示稿|路演稿|\b(?:presentation|slide\s*deck|slides?)\b)/iu.test(target)) return "ppt";
  if (/(?:视频|短片|动画|宣传片|影片|片子|\b(?:video|clip|animation|movie)\b)/iu.test(target)) return "video";
  if (/(?:图片|图像|海报|插画|配图|封面图?|头像|Logo|标志|照片|效果图|表情包|(?:一|两|三|四|五|\d+)?\s*张图|^图$|\b(?:image|picture|photo|poster|illustration|logo|thumbnail)\b)/iu.test(target)) return "image";
  return undefined;
}

export function isExplicitMediaCreationRequest(intent: "image" | "video", text: string): boolean {
  return naturalGenerationIntent(text) === intent;
}
