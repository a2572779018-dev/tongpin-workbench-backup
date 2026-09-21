import type { AiVideoModelCheck } from "../../../shared/aiVideo";
import { videoModel, type VideoModelId } from "../../../shared/aiVideoModels";

export function shouldApplyVideoDefault(selectionTouched: boolean, value: unknown, available?: readonly VideoModelId[]): value is VideoModelId {
  return !selectionTouched && typeof value === "string" && videoModel(value)?.generationEnabled === true && (!available || available.includes(value as VideoModelId));
}

export function checkedVideoModelNotice(check: AiVideoModelCheck, selected: VideoModelId): string {
  const model = check.models.find(item => item.id === selected);
  return model?.listed && check.availableModels.includes(selected)
    ? `${check.message} 当前默认模型 ${model.label} 已开放给成员。`
    : `${check.message} 当前默认模型未被开放给成员，请更换模型或核对令牌权限。`;
}
