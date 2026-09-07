import { Component, lazy, Suspense, type ReactNode } from "react";
import { useAmbientMotion } from "./useAmbientMotion";

const MetalFx = lazy(() => import("metal-fx").then(module => ({ default: module.MetalFx })));

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

function AnimatedIdentity() {
  const animate = useAmbientMotion();
  if (!animate) return <BrandImage />;
  return <MetalBoundary><Suspense fallback={<BrandImage />}>
    <MetalFx variant="circle" preset="silver" theme="light" strength={0.8}
      disableGlow normalizeHostStyles={false} className="tp-ai-identity-ring">
      <BrandImage />
    </MetalFx>
  </Suspense></MetalBoundary>;
}

/** Static by default. The optional GPU material is imported only after explicit opt-in. */
export function TongpinMetalIdentity({ richMotion = false }: { richMotion?: boolean }) {
  return (
    <div className="tp-ai-metal-identity" aria-hidden="true">
      {richMotion ? <AnimatedIdentity /> : <BrandImage />}
    </div>
  );
}
