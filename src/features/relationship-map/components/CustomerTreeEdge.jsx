import { BaseEdge } from "@xyflow/react";
import { CUSTOMER_COOPERATION_STATUS } from "../data/customerStatus.js";

function roundedPolyline(points, radius = 16) {
  if (points.length < 2) return "";
  const commands = [`M ${points[0].x} ${points[0].y}`];

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const incomingLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outgoingLength = Math.hypot(next.x - current.x, next.y - current.y);
    const cornerRadius = Math.min(radius, incomingLength / 2, outgoingLength / 2);

    if (cornerRadius <= 0.5) {
      commands.push(`L ${current.x} ${current.y}`);
      continue;
    }

    const incomingRatio = cornerRadius / incomingLength;
    const outgoingRatio = cornerRadius / outgoingLength;
    const beforeCorner = {
      x: current.x - (current.x - previous.x) * incomingRatio,
      y: current.y - (current.y - previous.y) * incomingRatio,
    };
    const afterCorner = {
      x: current.x + (next.x - current.x) * outgoingRatio,
      y: current.y + (next.y - current.y) * outgoingRatio,
    };

    commands.push(`L ${beforeCorner.x} ${beforeCorner.y}`);
    commands.push(`Q ${current.x} ${current.y} ${afterCorner.x} ${afterCorner.y}`);
  }

  const last = points[points.length - 1];
  commands.push(`L ${last.x} ${last.y}`);
  return commands.join(" ");
}

export function customerTreeEdgePaths({ sourceX, sourceY, targetX, targetY, layout }) {
  if (layout === "pyramid") {
    if (Math.abs(sourceX - targetX) < 0.5) {
      return {
        trunkPath: null,
        customerPath: `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`,
      };
    }
    const branchY = sourceY + (targetY - sourceY) * 0.46;
    return {
      trunkPath: roundedPolyline([
        { x: sourceX, y: sourceY },
        { x: sourceX, y: branchY },
        { x: targetX, y: branchY },
      ]),
      customerPath: `M ${targetX} ${branchY} L ${targetX} ${targetY}`,
    };
  }

  const branchX = sourceX + (targetX - sourceX) * 0.46;
  return {
    trunkPath: roundedPolyline([
      { x: sourceX, y: sourceY },
      { x: branchX, y: sourceY },
      { x: branchX, y: targetY },
    ]),
    customerPath: `M ${branchX} ${targetY} L ${targetX} ${targetY}`,
  };
}

export function customerTreeEdgePath(options) {
  const { trunkPath, customerPath } = customerTreeEdgePaths(options);
  return [trunkPath, customerPath].filter(Boolean).join(" ");
}

export function CustomerTreeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerStart,
  markerEnd,
  style,
  data,
}) {
  const { trunkPath, customerPath } = customerTreeEdgePaths({
    sourceX,
    sourceY,
    targetX,
    targetY,
    layout: data?.layout,
  });
  const customerStyle = {
    ...style,
    strokeDasharray: data?.cooperationStatus === CUSTOMER_COOPERATION_STATUS.PENDING
      ? "7 8"
      : undefined,
  };
  const trunkStyle = { ...style, strokeDasharray: undefined };

  return (
    <>
      {trunkPath ? (
        <BaseEdge
          id={`${id}-trunk`}
          path={trunkPath}
          markerStart={markerStart}
          style={trunkStyle}
        />
      ) : null}
      <BaseEdge
        id={id}
        path={customerPath}
        markerStart={trunkPath ? undefined : markerStart}
        markerEnd={markerEnd}
        style={customerStyle}
      />
    </>
  );
}
