import type { AiWorkspaceState } from "../../../shared/aiWorkspace";
import type { VideoChatRequest } from "./videoChat";
import { videoReferenceDraftAttachments } from "./videoReferenceAttachments";

/** Persist only editable video inputs when planning needs clarification. */
export function preserveVideoClarificationDraft(
  state: AiWorkspaceState,
  conversationId: string,
  prompt: string,
  request: VideoChatRequest,
): AiWorkspaceState {
  const referenceDrafts = videoReferenceDraftAttachments(
    request.referenceImages ?? [],
    `video-reference-${conversationId}`,
  );
  const draftAttachments = { ...(state.draftAttachments ?? {}) };
  if (referenceDrafts.length) draftAttachments[conversationId] = referenceDrafts;
  else delete draftAttachments[conversationId];
  return {
    ...state,
    drafts: { ...state.drafts, [conversationId]: prompt },
    draftAttachments,
    videoDraftSettings: {
      ...(state.videoDraftSettings ?? {}),
      [conversationId]: {
        ...(request.model ? { model: request.model } : {}),
        seconds: request.seconds,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
      },
    },
  };
}
