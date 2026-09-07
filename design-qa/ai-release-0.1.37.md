# Tongpin AI 0.1.37 — release candidate verification

**Superseded / not delivered.** Subsequent user testing exposed dropped cursor
frames and unnatural tracking after clicks. The maximum-fps assertions below
did not establish smoothness. Windows CI also exposed a CRLF-sensitive geometry
text hash test. CI 34104772067 failed and publication was skipped; only draft
release 383961971 with five Mac assets exists. No 0.1.37 update manifest was
activated and no 0.1.37 app was installed. Continue with the corrected 0.1.38
candidate rather than rewriting this tag or claiming this candidate passed
the subsequently reported user requirements.

Verified on 2026-09-07. Publication and installation are separate operations;
this document records the tested source, not a claim of deployed delivery.

## User-facing scope

- One paid Metalforge Fleur character replaces the old repeated AI marks and
  optional Orb/beam controls. The standalone animation switch is removed.
- All 14 expression choices render immediately and persist per account; actual
  pending/success/error states take precedence. Switching conversations does
  not create a false completion expression.
- Fleur gently looks toward the pointer without moving its container. It is
  limited to 30fps and pauses when hidden, off-screen or reduced-motion is on.
- The user's directional Tongpin arrow is restored, not replaced by a fixed
  bitmap. It updates only after pointer input, at most 60fps, with no idle loop
  or layout reads. Blur/leave/hidden cancel pending paint. Text fields, native
  selects and disabled controls retain their native cursors. A main-thread
  stall can still delay any DOM cursor; no universal no-lag claim is made.
- Member overview shows remaining percentage only. Limits and converted costs
  are called 同频点; real input/output Token counts remain in usage details.
  This is presentation only: conversion, balances and historic accounting do
  not change, including the existing uncertain image record.
- Image generation is a separate route and no longer shows the unrelated
  quick/deep text selector. Admins can explicitly enable standard image SSE.
  Safe diagnostic categories distinguish provider failures from bad settings.

## Automated checks

- `npm run build`: typecheck, **107 files / 951 tests**, renderer and API builds passed.
- `npm run typecheck:cloudflare`: passed.
- `npm run cloudflare:check`: Worker dry-run passed.
- SSE parser and real workerd tests cover completed images, rejected partial
  events, bounds, trailing errors, diagnostics persistence and accounting.
- Persona tests cover owner isolation, all expression values, legacy omitted
  fields, reset, revision conflicts, and no expression injection into prompts.
- Fleur is a lazy 104.91kB (32.95kB gzip) chunk. No legacy Orb/material/beam
  renderer chunk is loaded in the current workspace.

## Independent isolated browser verification

`scripts/verify-ai-character.cjs` uses only loopback fixture accounts and an
isolated headless Chrome context; no production account or paid message.
Current merged report: **22 / 22 passed**, zero page errors. Two console errors
were intentionally induced by blocking the decorative character module and
confirming local fallback without losing the conversation interface.

- All 14 expressions: immediate glyph, save, reload, re-enter AI, still selected.
- Directional arrow: right/down/left/up, stationary 750ms with zero style writes,
  textarea/select/disabled computed styles, pending-frame cancellation,
  reduced motion, and exactly one instance across AI/tasks.
- Character pauses/resumes correctly. Long history initially mounts 40 rows,
  and explicitly loading earlier messages expands to 80 of 160 fixture rows.
- Member/Boss workspaces and percentage-only quota overview passed.
- Welcome question/heart at widths 1440, 1023 and 720, pointer at all four
  corners: no overlap; minimum measured title gap 41.59px. The actual SVG,
  not just its lazy-load placeholder, was visually checked on onboarding.

Evidence directory (kept outside the repository):
`/Users/sam/Documents/ChatGPT/个人/tongpin-release-downloads/qa-0.1.37/`

`browser-character-final.json` SHA256:
`628f1578a9c48f17660e24e492ee7a1c01a2810e6c15259edc95b09bee0cd73b`

The earlier fixed-native-cursor check is explicitly superseded by the user's
request for a directional arrow. Earlier test-navigation/loading assumptions
were corrected; a real welcome SVG sizing issue was fixed and rechecked.

## External provider boundary

The logged-in NIcoNIco sidebar instructed image-center use of streaming. Its
separate public image center `https://img.hubniconico.com/` returned Cloudflare
HTTP 521 at 08:35:42 UTC. This is not proof that the configured API image
endpoint shares that failure. The visible usage page contained three text
requests and no image entry; absence is not proof that billing did not occur.

No production API key, provider configuration, member balance or historic
uncertain charge was changed. No paid image was generated during this QA.
Standard SSE compatibility is tested; a real provider image result still
requires confirmation. Do not describe the live image service as verified.

## Release boundaries

Deploy the compatible backend before distributing the client: expression is
an optional new profile field and legacy writes preserve it. Do not roll the
Worker back to the old strict schema after new profiles have been saved.

Keep the private paid export source private. Only the integrated runtime is
bundled; the downloaded ZIP and standalone demo are not release assets.

Publish and completely verify package bodies before activating the Windows
manifest. Unsigned universal macOS packages are manually installed; leave the
public automatic Mac manifest unchanged. Back up user data and replace only
the validated `/Applications/同频.app`, keeping the old app recoverable.
