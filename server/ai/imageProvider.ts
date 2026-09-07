import type { StoredProvider } from "./storage";
import { object, readBoundedText } from "./provider";
import { AiError } from "./security";

export const MAX_IMAGE_RESPONSE_BYTES = 6_000_000;

/** Images API streaming is separate from Responses/chat reasoning. Never probe by sending an extra generation. */
export function imageProviderBody(provider: StoredProvider, prompt: string): Record<string, unknown> {
  return {
    model: provider.imageModel, prompt, n: 1, size: "1024x1024",
    ...(/^gpt-image/i.test(provider.imageModel ?? "") ? { output_format: "jpeg" } : { response_format: "b64_json" }),
    // No progressive previews: partial images can be additionally billed and consume buffering/storage.
    ...(provider.imageStream ? { stream: true, partial_images: 0 } : {}),
  };
}

/** Accept one complete JSON image or a standard image_generation.completed SSE event.
 * Never deliver partial images, follow URL-only results, or retry after an interrupted paid stream.
 * https://developers.openai.com/api/reference/resources/images/generation-streaming-events
 */
export async function readImageProviderResponse(response: Response): Promise<unknown> {
  const text = await readBoundedText(response, MAX_IMAGE_RESPONSE_BYTES);
  const prefix = text.trimStart();
  const isStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || /^(?:event:|data:|:)/.test(prefix);
  if (!isStream) {
    try { return JSON.parse(text) as unknown; }
    catch { throw new AiError(502, "AI_IMAGE_FORMAT_UNSUPPORTED", "图片服务未返回完整 JSON 或标准 Images SSE，请管理员核对图片接口格式"); }
  }
  let completed: string | undefined;
  // Iterate blocks without copying the entire multi-megabyte body to normalize newlines.
  const delimiter = /\r?\n\r?\n/g;
  let start = 0;
  for (;;) {
    const match = delimiter.exec(text);
    const block = text.slice(start, match?.index ?? text.length);
    const lines = block.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (data && data !== "[DONE]") {
      let event: Record<string, unknown>;
      try { event = object(JSON.parse(data)); }
      catch { throw new AiError(502, "AI_IMAGE_STREAM_INVALID", "图片数据流格式损坏，用量待管理员核对"); }
      const eventName = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
      if (eventName && typeof event.type === "string" && eventName !== event.type) throw new AiError(502, "AI_IMAGE_STREAM_INVALID", "图片数据流事件不一致，用量待管理员核对");
      const type = event.type ?? eventName;
      if (type === "error" || type === "image_generation.failed" || event.error) throw new AiError(502, "AI_IMAGE_STREAM_FAILED", "图片服务未完成生成，用量待核对；请管理员先核对服务商记录");
      if (type === "image_generation.completed") {
        if (completed !== undefined || typeof event.b64_json !== "string" || !event.b64_json) throw new AiError(502, "AI_IMAGE_STREAM_INVALID", "图片数据流未返回唯一完整图片，用量待管理员核对");
        completed = event.b64_json;
      }
      // In particular, image_generation.partial_image and [DONE] alone are not a successful image.
    }
    if (!match) break;
    start = delimiter.lastIndex;
  }
  if (!completed) throw new AiError(502, "AI_IMAGE_STREAM_INTERRUPTED", "图片数据流中断或未返回最终图片，用量待核对；请勿直接重复生成");
  return { data: [{ b64_json: completed }] };
}
