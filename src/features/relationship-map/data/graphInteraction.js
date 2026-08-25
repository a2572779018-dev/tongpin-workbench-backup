const DEFAULT_NODE_SIZE = 76;
const ROOT_NODE_SIZE = 96;

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function focusPlanForNode(node, currentZoom = 1) {
  const fallbackSize = node?.id === "self" ? ROOT_NODE_SIZE : DEFAULT_NODE_SIZE;
  const width = finiteNumber(node?.measured?.width, fallbackSize);
  const height = finiteNumber(node?.measured?.height, fallbackSize);
  const zoom = finiteNumber(currentZoom, 1);
  const targetZoom = zoom >= 1.36
    ? zoom
    : Math.min(1.36, Math.max(1.12, zoom + 0.18));

  return {
    x: finiteNumber(node?.position?.x, 0) + width / 2,
    y: finiteNumber(node?.position?.y, 0) + height / 2,
    zoom: targetZoom,
  };
}
