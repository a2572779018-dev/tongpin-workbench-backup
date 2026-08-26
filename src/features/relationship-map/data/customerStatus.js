export const CUSTOMER_COOPERATION_STATUS = {
  COLLABORATED: "collaborated",
  PENDING: "pending",
};

export const CUSTOMER_COOPERATION_OPTIONS = [
  { value: CUSTOMER_COOPERATION_STATUS.COLLABORATED, label: "已合作客户" },
  { value: CUSTOMER_COOPERATION_STATUS.PENDING, label: "待合作客户" },
];

export function normalizeCustomerCooperationStatus(value) {
  return value === CUSTOMER_COOPERATION_STATUS.PENDING
    ? CUSTOMER_COOPERATION_STATUS.PENDING
    : CUSTOMER_COOPERATION_STATUS.COLLABORATED;
}

export function customerCooperationStatusLabel(value) {
  return normalizeCustomerCooperationStatus(value) === CUSTOMER_COOPERATION_STATUS.PENDING
    ? "待合作客户"
    : "已合作客户";
}

export function customerIdForEdge(sourceId, targetId, depthById) {
  const sourceDepth = depthById?.get(sourceId) ?? 0;
  const targetDepth = depthById?.get(targetId) ?? 0;
  return sourceDepth > targetDepth ? sourceId : targetId;
}
