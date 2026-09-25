/** Member-facing reason for a failed media task. Codes are server-owned and
 * never contain provider secrets; unknown codes still show the code so an
 * administrator can match it in 运行监控. */
const REASONS: Record<string, string> = {
  AI_TOOL_PLAN_INVALID: "AI 整理的生成方案格式不正确，服务商未被调用",
  AI_TOOL_PLAN_MISMATCH: "生成方案与原任务不一致，已拦下未提交",
  AI_TOOL_PLAN_CONTEXT_MISMATCH: "生成方案与当前对话资料不一致，已拦下未提交",
  AI_TOOL_PLAN_EXPIRED: "生成方案已过期，请重新发送",
  AI_MEDIA_TASK_PLAN_FAILED: "AI 整理生成方案时失败，服务商未被调用",
  AI_MEDIA_TASK_DEADLINE: "任务超过等待期限",
  AI_MEDIA_TASK_INPUT_TIMEOUT: "等待补充信息超时",
  AI_MEDIA_TASK_NOT_CONFIGURED: "管理员尚未为此档位配置生成服务",
  AI_MEDIA_TASK_BUDGET_INVALID: "额度确认无效或额度不足",
  AI_VIDEO_FAILED: "视频服务商返回生成失败",
  AI_VIDEO_DISABLED: "管理员尚未启用视频生成",
  AI_VIDEO_KEY_REQUIRED: "视频服务缺少可用密钥，请联系管理员",
  AI_VIDEO_MODEL_INVALID: "视频模型设置无效，请联系管理员",
  AI_VIDEO_MODEL_UNAVAILABLE: "视频模型当前不可用",
  AI_VIDEO_MODEL_NOT_AUTHORIZED: "当前账号未开放该视频模型",
  AI_VIDEO_SETTINGS_INVALID: "视频时长、清晰度或画幅不被当前模型支持",
  AI_VIDEO_INPUT_INVALID: "视频描述或参数不被服务商接受",
  AI_VIDEO_RESPONSE_INVALID: "视频服务商返回的数据无法识别",
  AI_VIDEO_CONTENT_INVALID: "视频服务商返回的视频文件无效",
  AI_VIDEO_IMAGE_INVALID: "参考图不被视频服务接受",
  AI_IMAGE_FAILED: "图片服务商返回生成失败",
  AI_IMAGE_DISABLED: "管理员尚未启用图片生成",
  AI_IMAGE_PROMPT_INVALID: "图片描述不被服务商接受",
  AI_PROVIDER_TIMEOUT: "服务商响应超时",
  AI_PROVIDER_REJECTED: "服务商拒绝了请求",
};

export function mediaTaskFailureText(code: string | undefined): string {
  if (!code) return "未返回具体原因";
  const reason = REASONS[code];
  return reason ? `${reason}（${code}）` : `错误代码 ${code}`;
}
