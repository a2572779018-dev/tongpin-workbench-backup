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

/** A generation request is a protocol contract selected by an administrator,
 * not a capability inferred from a /models entry or a model ID substring.
 * Aliased relay models may implement only part of their upstream contract.
 */
export type AiImageGenerationProfile =
  | "openai-gpt-image-generations-v1"
  | "openai-dall-e-2-generations-v1"
  | "openai-dall-e-3-generations-v1";
export interface AiImageGenerationCapability {
  baseUrl: string;
  modelId: string;
  profile: AiImageGenerationProfile;
  size: string;
}

/** Conservative, versioned /images/generations request shapes.
 * https://developers.openai.com/api/reference/cli/resources/images/methods/generate
 * These are protocol choices, not a promise that a given relay alias supports them.
 */
export const AI_IMAGE_GENERATION_PROFILE_SPECS = {
  "openai-gpt-image-generations-v1": {
    label: "GPT Image 兼容生成",
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    maxPromptCharacters: 32_000,
    outputField: "output_format", outputFormat: "jpeg", stream: true,
  },
  "openai-dall-e-2-generations-v1": {
    label: "DALL·E 2 兼容生成",
    sizes: ["256x256", "512x512", "1024x1024"],
    maxPromptCharacters: 1_000,
    outputField: "response_format", outputFormat: "b64_json", stream: false,
  },
  "openai-dall-e-3-generations-v1": {
    label: "DALL·E 3 兼容生成",
    sizes: ["1024x1024", "1792x1024", "1024x1792"],
    maxPromptCharacters: 4_000,
    outputField: "response_format", outputFormat: "b64_json", stream: false,
  },
} as const;
