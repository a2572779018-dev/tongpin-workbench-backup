import { Component, type ReactNode } from "react";
import { MetalFx } from "metal-fx";
import { useAmbientMotion } from "./useAmbientMotion";

function BrandImage() {
  return (
    <img
      className="tp-ai-metal-identity__logo"
      src="./app-icon.svg"
      alt="同频"
      draggable={false}
    />
  );
}

class MetalBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <BrandImage /> : this.props.children;
  }
}

/** Reuses Tongpin's own artwork; no third-party character geometry or paid export. */
export function TongpinMetalIdentity() {
  const animate = useAmbientMotion();
  return (
    <div className="tp-ai-metal-identity" aria-hidden="true">
      <MetalBoundary>
        <MetalFx
          variant="circle"
          preset="silver"
          theme="light"
          strength={0.8}
          paused={!animate}
          disableGlow
          normalizeHostStyles={false}
          className="tp-ai-identity-ring"
        >
          <BrandImage />
        </MetalFx>
      </MetalBoundary>
    </div>
  );
}
