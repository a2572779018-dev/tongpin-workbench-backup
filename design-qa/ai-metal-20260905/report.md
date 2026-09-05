# 同频 AI：独立科技视觉验收

Date: 2026-09-05

## Scope and result

**passed** for the local visual integration and regression checks described below.

Reference-led component integration, not a pixel-for-pixel clone of three websites.
The selected materials are graphite, cool silver and restrained blue-violet light.
The task and customer-graph views retain their existing styles. Projects, chats,
Skills, account usage, confirmation dialogs and role isolation remain intact.

The current AI service is still disconnected. No generated reply, file, charge,
server quota enforcement or persistent database was introduced by this work.
No deployment, release, purchase or paid export was performed.

## Sources and licensing

- [LerSent001/orb](https://github.com/LerSent001/orb), MIT, commit
  `047c58cc93587c21dac12183fc0fb1e4101c8e1a`: local WebGPU renderer subset and
  the user's chromaticMetal colors/state timings. The small header identity is
  silver while idle; only a caller-provided responding state activates blue-violet.
- [Jakubantalik/metal-fx](https://github.com/Jakubantalik/metal-fx), MIT, npm
  `metal-fx@1.0.4`, source commit `be1bf89c63056521a4e8224f368768314c9006f7`:
  the circular metal rim around Tongpin's existing logo on the empty chat screen.
- [Jakubantalik/Libraries.dev](https://github.com/Jakubantalik/Libraries.dev),
  MIT for `packages/border-beam`, commit `999866f33df216dab0f8956f91c8d2e918d46328`:
  the composer ocean-palette border. The unchanged five source files are vendored
  because the source-declared 1.4.0 package was not available on npm.
- [MetalForge character](https://metalforge.xyz/character) was visually inspected
  in the user's existing signed-in browser. Its editor explicitly gates downloads
  behind Pro. Its linked original [Avatar Lab](https://github.com/smontlouis/bible-strong-avatar-lab)
  uses AGPL-3.0-only at commit `79fe9ba06e4874b11394b8e8a3f2c493c9d197ba`.
  No paid export, character geometry or AGPL runtime was copied. The integration
  uses Tongpin's own logo instead; an exact MetalForge character remains outside
  this delivery without an appropriately licensed export or separate licensing decision.

Complete notices are included in the repository's `THIRD_PARTY_NOTICES.md`,
which is also included in the existing Electron packaging configuration.

## Visual comparison evidence

The three reference screenshots and the implemented desktop screenshot were
opened together in one comparison input. This compares materials and component
placement, not the unrelated reference websites' editor/navigation layouts.

| Surface | Reference and implemented treatment | Assessment |
| --- | --- | --- |
| Palette and surface | Metal/Beam dark source surfaces; graphite AI panel, cool text, fine borders | Distinct from Tongpin's task view without excess brightness |
| Brand focal point | Source metal circle; original Tongpin logo in a 112 px metal rim | Correct ratio, no stretched or copied character artwork |
| State identity | Orb source blue-violet thinking; 40 px silver idle header orb | Intentional idle-state difference; no fake ongoing request |
| Composer | Beam source glow; 20 px rounded input with subtle ocean glow on focus/responding | Text remains readable, menu is not clipped |
| Navigation and overlays | Existing Tongpin project/chat structure retained, dialogs restyled | No sidebar overlap, no lost controls; mobile top tabs fit |

Reference captures: `source-orb.png` (1023×933), `source-metal.png` (1265×712),
`source-beam.png` (1008×919). Material-only references intentionally retain their
captured page framing. Implemented desktop viewport: 1023×933. Mobile: 390×844.

Implementation evidence:

- `implementation-desktop.png`: idle GPU orb and metal logo, empty workspace.
- `implementation-plus-menu.png`: attachment/generation menu fully visible.
- `implementation-project-dialog.png`: project confirmation and name field.
- `implementation-delete-dialog.png`: destructive confirmation for the temporary QA project.
- `implementation-token-details.png`: usage dialog, unknown values shown as unknown.
- `implementation-mobile.png`: narrow composer and navigation without horizontal overflow.
- `implementation-mobile-plus-menu.png`: all four plus-menu items fit the viewport.
- `implementation-tasks-unchanged.png`: task view restored to original theme.

Some browser capture files use JPEG encoding despite the `.png` suffix, as in the
existing QA evidence; dimensions were verified with `sips`.

## Findings fixed during this pass

1. Beam's upstream `overflow: hidden` clipped the top half of the plus menu.
   An AI-scoped wrapper override now permits overflow without changing source.
2. The outer body retained a warm background strip in AI. Background and decorative
   texture overrides are gated by `html[data-app-view="ai"]` only.
3. Skill category labels inherited a light background with low-contrast text.
   They now use a dark, readable category surface.
4. Mobile navigation was eight pixels too wide. Scoped spacing and font adjustments
   keep the three destinations on one line with no internal horizontal scrolling.
5. A hidden zero-sized Orb target did not reliably trigger an intersection threshold.
   Size checks, ResizeObserver and resize cleanup now stop it when hidden. Browser
   verification observed `fallback` at 390 px and `webgpu` after desktop restoration.
6. Project toast inherited a bright green surface. Its actual selector now receives
   a subdued, readable status style; the focused textarea uses the composer's
   existing visible focus border instead of a second square outline.

## Interaction, accessibility and runtime verification

- New project opens the named confirmation dialog; cancellation creates no project.
- A temporary empty QA project was created, its context menu and delete confirmation
  were checked, then that QA project was removed. The project list was restored to empty.
- Project/chat grouping, context actions and administrative isolation retain prior
  state logic and regression coverage; no member-admin controls were added.
- Plus menu is complete, keyboard Escape returns focus, and unavailable services
  remain disabled. No external uploads or generation calls were triggered.
- Skill market opens with six entries; its cards, categories and filters remain usable.
- Profile opens the Token dialog; counts remain unsynced rather than fabricated.
- Desktop and narrow layouts have no document horizontal overflow.
- Task and customer-graph navigation restore their original body backgrounds and
  remove Orb/Beam/Metal identity hosts from the DOM.
- Browser error/warning log query returned no entries in the tested page.
- Motion handles document visibility and reduced-motion preference changes;
  Orb also handles viewport visibility, lazy shader loading, loss/error fallback,
  and cleanup. Reduced-motion and unsupported-GPU paths have source/SSR coverage,
  not a separately emulated GPU-failure end-to-end run.
- GPU thinking visuals are wired to real request state, but a live model response
  cannot be verified until a provider/backend is connected.

## Automated checks

- `npm run typecheck`: passed.
- `npm run test -- --maxWorkers=2`: 68 files / 376 tests passed.
- `npm run build:web`: passed; Orb shader remains a lazy separate chunk.
- `git diff --check`: passed.

The first unconstrained full-suite run had one timeout in the unrelated existing
LORA legacy aggregate migration test (45-second limit). Rerunning the full suite
with two workers passed without changing that test or its timeout.
