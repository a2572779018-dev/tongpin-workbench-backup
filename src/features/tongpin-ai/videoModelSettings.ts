import { videoModel, type VideoModelId } from "../../../shared/aiVideoModels";

export function shouldApplyVideoDefault(selectionTouched: boolean, value: unknown, available?: readonly VideoModelId[]): value is VideoModelId {
  return !selectionTouched && typeof value === "string" && videoModel(value)?.generationEnabled === true && (!available || available.includes(value as VideoModelId));
}
