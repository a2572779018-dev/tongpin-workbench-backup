# Liquid Orb renderer (vendored subset)

Source: https://github.com/LerSent001/orb

Upstream commit: `047c58cc93587c21dac12183fc0fb1e4101c8e1a`

License: MIT, Copyright (c) 2026 LerSent001. The complete upstream license is
preserved in `LICENSE`. No Toolcraft UI source is included.

This subset contains the renderer, parameter presets, state transitions, uniform
mapping, shader wrapper, particle constant, and WGSL shader. It does not load any
remote assets or services.

Tongpin modifications to `src/orb-renderer.ts`:

- Limit device pixel ratio to 1.5.
- Limit idle rendering to approximately 30 frames per second.
- Stop setup before requesting a device when the renderer was already disposed.
- Stop initialization after asynchronous shader compilation if disposed.

The host `TongpinOrb.tsx` provides lazy loading, component cleanup, document and
intersection visibility handling, reduced-motion support, and the existing
Tongpin icon as the fallback. Thinking activation is controlled by its caller;
the renderer does not make model requests or imply a successful connection.
