# Tongpin AI 0.1.38 — verified release candidate

Verified 2026-09-07. This records source verification, not publication or local
installation. The superseded 0.1.37 tag was not delivered; do not rewrite it.

## Latest user corrections

- Directional cursor paints once after pointer input at the display cadence,
  with no fractional 60Hz gate, no idle loop, no React state or layout reads.
  Native editing/disabled cursors and blur/hidden cleanup remain intact.
- Fleur tracks its actual rendered SVG origin, including impression padding,
  resizing and layout changes. Stationary input is retained after a click.
  New character containers recompute from the recent viewport point instead
  of reusing an old angle. No mouse history is persisted.
- Pointer yaw/pitch increased from 7/5 degrees to 14/10; competing expression
  head gestures are bounded while eye shapes and impression timing remain.
- The 30fps character clock compensates for rounded timestamps and small
  display-clock drift. Real RAF trace regressions prevent alternating 16/50ms
  updates. Hidden/offscreen/reduced-motion suspension remains unchanged.
- Windows CRLF conversion no longer changes the geometry-source hash check.
  The purchased geometry itself has not been replaced.

The Fleur expressions, percentage-only member overview, 同频点 terminology,
real Token details, separate image generation route and optional image SSE
support from the previous candidate are retained. No keys, balances, historic
uncertain charges, customer graphs, or saved user preferences were reset.

## Build and regression checks

- `npm run build`: 107 files / **969 tests passed**, typecheck, renderer and API
  builds passed. Fleur remains a lazy 106.24kB chunk (33.45kB gzip).
- `npm run typecheck:cloudflare` and `npm run cloudflare:check`: passed.
- Test-only macOS Supertest listener isolation was corrected in AI acceptance
  and LORA route tests. A self-owned IPv4/wildcard dual-listener experiment
  reproduced the wrong-loopback-target problem; tests now await an explicitly
  bound IPv4 server and close it before restart. No retries, product route,
  accounting or permission changes were introduced to make tests pass.

## Independent browser measurements

The two committed verification scripts use an isolated headless Chrome and
loopback-only fixtures. No user browser profile, production account, paid chat
or saved persona was modified. Five runtime source hashes were captured before
and after each run and matched the final checked-out source.

- Performance checks: **6/6 passed**. Normal active cursor 60.01fps, character
  29.99fps. Character update intervals: median 33.3ms, p95 34.1ms, max 35.1ms;
  the former regular short/long update pattern is gone.
- All four active/static and normal/4x CPU scenarios had exactly one cursor
  style write per injected RAF pointer event, no stale coordinates, no missed
  previous-input writes, zero stationary cursor writes and zero console errors.
- Under 4x CPU throttling, browser RAF averaged 58.22fps and cursor 58.32fps;
  cursor interval p95 was 30ms and character p95 40ms. This is not a guarantee
  of 60fps on all computers or physical trackpad/compositor zero latency.
- Geometry/click checks: **17/17 passed**. Actual screen-space eye centers were
  checked relative to the flower, not merely changing SVG path hashes.
  Left/right/up/down, stationary hold, blank/tools clicks, settings layout
  movement without a subsequent pointer move, question/heart impressions and
  all corners in welcome/settings/chat-header contexts passed.
- Earlier 14-expression save/reload and member isolation evidence is retained
  in the 0.1.37 candidate report, not misrepresented as repeated persistence
  writes in these read-only geometry tests.

Evidence outside the repository:
`/Users/sam/Documents/ChatGPT/个人/tongpin-release-downloads/qa-0.1.38/`

- `pointer-performance-summary.json` SHA256:
  `cf390055964f6d2bcfaeb3aa9c21b5793e8e87d7748ca5ecf934637b5817c255`
- `follow-geometry-summary.json` SHA256:
  `2842283153071320d2bc31def119bb40583b8ea0e4ca80b6edc58e248e332ece`

## Delivery and external-service boundaries

The compatible persona/image backend was deployed before client distribution
(Worker version `3f2abce2-a775-413e-8b1d-be9e99364cce`). Current corrections are
client/test changes; do not roll back to a strict legacy persona schema.

Real NIcoNIco image generation remains unverified. The separate image-center
website returned HTTP 521, which is not proof about the configured API endpoint.
No paid image, API-key change, image-stream enabling, refund or quota edit was
performed by these tests. Standard JSON/SSE compatibility is tested, not the
provider's live result.

Only activate the Windows update manifest after full remote package-body and
blockmap verification. Unsigned macOS remains manual install: keep the public
Mac automatic manifest at its existing 0.1.28 hash. Back up user data, verify
the universal app and ASAR, replace only `/Applications/同频.app`, and retain
the previous app recoverably. Record delivery evidence separately.
