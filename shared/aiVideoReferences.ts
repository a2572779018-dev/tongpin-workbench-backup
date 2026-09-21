export const AI_VIDEO_REFERENCE_FINGERPRINT = /^[a-f0-9]{64}$/;

/** Binds a planned video request to the exact normalized JPEG references, in order. */
export async function aiVideoReferenceFingerprint(dataUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dataUrl));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
