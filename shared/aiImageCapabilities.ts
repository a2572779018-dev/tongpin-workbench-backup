/** An administrator-declared protocol binding, never inferred from a discovered model name. */
export type AiImageEditProfile = "openai-gpt-image-edits-v1" | "openai-dall-e-2-edits-v1";
export interface AiImageEditCapability {
  baseUrl: string;
  modelId: string;
  profile: AiImageEditProfile;
}

/** Conservative, versioned Images multipart contracts. Aliases require an explicit binding above.
 * https://developers.openai.com/api/reference/typescript/resources/images/methods/edit
 * The application may enforce lower upload limits than these protocol maxima.
 */
export const AI_IMAGE_EDIT_PROFILE_SPECS = {
  "openai-gpt-image-edits-v1": {
    label: "GPT Image 编辑兼容接口",
    mimeTypes: ["image/png", "image/jpeg", "image/webp"] as readonly string[],
    maxReferences: 16, maxReferenceBytes: 50_000_000, maxPromptCharacters: 32_000,
    squareInput: false, size: "1024x1024", outputFormat: "jpeg", stream: true,
  },
  "openai-dall-e-2-edits-v1": {
    label: "DALL·E 2 编辑兼容接口",
    mimeTypes: ["image/png"] as readonly string[],
    maxReferences: 1, maxReferenceBytes: 4_000_000, maxPromptCharacters: 1_000,
    squareInput: true, size: "1024x1024", outputFormat: "b64_json", stream: false,
  },
} as const;

/** Same aggregate limit as existing chat attachments; prevents unbounded multipart allocation. */
export const AI_IMAGE_EDIT_MAX_INPUT_BYTES = 1024 * 1024;
