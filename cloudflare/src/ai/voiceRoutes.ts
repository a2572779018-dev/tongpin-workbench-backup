import type { AiService } from "../../../server/ai/service";
import { parseTranscriptionUpload } from "../../../server/ai/voiceAudio";
import { AI_VOICE_SPEECH_PATH, AI_VOICE_TRANSCRIPTION_PATH } from "../../../shared/aiVoice";
import { json } from "../platform";

/**
 * Worker voice routes. Called by handleAiRequest after authentication, the
 * account-binding header check, tenant scoping and the admin/member role
 * checks, so `service` is already the caller's tenant. Returns null for any
 * other path. The outer Worker entry buffers the upload with the AI voice
 * body bound before it reaches the Durable Object.
 */
export async function handleAiVoiceRequest(
  request: Request,
  path: string,
  method: string,
  service: AiService,
  userId: string,
  readJson: () => Promise<unknown>,
): Promise<Response | null> {
  if (path === "/api/admin/ai/voice") {
    if (method === "GET") return json({ settings: service.voice.settings(), readiness: service.voice.readiness() });
    if (method === "PUT") {
      const settings = await service.voice.configure(await readJson());
      return json({ settings, readiness: service.voice.readiness() });
    }
    return null;
  }
  if (path === "/api/ai/voice" && method === "GET") return json({ settings: service.voice.memberSettings() });
  if (path === AI_VOICE_TRANSCRIPTION_PATH && method === "POST") {
    service.voice.assertInputAvailable(userId);
    return json(await service.voice.transcribe(userId, await parseTranscriptionUpload(request)));
  }
  if (path === AI_VOICE_SPEECH_PATH && method === "POST") return service.voice.speech(userId, await readJson());
  return null;
}
