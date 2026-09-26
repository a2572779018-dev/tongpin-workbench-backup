import type { Request as ExpressRequest, Router } from "express";
import { AI_VOICE_LIMITS } from "../../shared/aiVoice";
import { AiError } from "./security";
import type { AiVoiceService } from "./voice";
import { parseTranscriptionUpload } from "./voiceAudio";

/** Bounded copy of an Express multipart body into a Web Request, so the same
 * FormData parser runs in Node and in the Worker. The rest of an oversized
 * upload is drained, never buffered. */
export async function expressUploadRequest(request: ExpressRequest, limit: number = AI_VOICE_LIMITS.uploadBytes): Promise<Request> {
  const tooLarge = () => new AiError(413, "AI_VOICE_AUDIO_TOO_LARGE", "录音文件过大，单次最多 10 MB、60 秒");
  const declared = Number(request.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { request.resume(); throw tooLarge(); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk as Uint8Array;
    size += bytes.byteLength;
    if (size > limit) { request.resume(); throw tooLarge(); }
    chunks.push(bytes);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Request("http://127.0.0.1/api/ai/audio/transcriptions", {
    method: "POST", headers: { "content-type": request.get("content-type") ?? "", "content-length": String(size) }, body,
  });
}

/** Registered after the router's role guard: admin routes on the admin
 * router, member routes on the member router. Tenant scope comes from the
 * authenticated principal through `voice(request)`. */
export function registerAiVoiceRoutes(router: Router, voice: (request: ExpressRequest) => AiVoiceService, admin: boolean): void {
  if (admin) {
    router.get("/voice", (request, response) => {
      const service = voice(request);
      response.json({ settings: service.settings(), readiness: service.readiness() });
    });
    router.put("/voice", async (request, response) => {
      const service = voice(request);
      const settings = await service.configure(request.body);
      response.json({ settings, readiness: service.readiness() });
    });
    return;
  }
  router.get("/voice", (request, response) => response.json({ settings: voice(request).memberSettings() }));
  router.post("/audio/transcriptions", async (request, response) => {
    const service = voice(request);
    try { service.assertInputAvailable(request.currentUser!.id); } catch (error) { request.resume(); throw error; }
    const upload = await parseTranscriptionUpload(await expressUploadRequest(request));
    response.json(await service.transcribe(request.currentUser!.id, upload));
  });
  router.post("/audio/speech", async (request, response) => {
    const result = await voice(request).speech(request.currentUser!.id, request.body);
    result.headers.forEach((value, key) => response.set(key, value));
    response.status(result.status).send(Buffer.from(await result.arrayBuffer()));
  });
}
