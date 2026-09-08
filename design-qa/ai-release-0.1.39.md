# Tongpin AI 0.1.39 — source verification

Verified 2026-09-08. This document is not proof of distribution, installation, or
successful image generation. Record delivery and installed-member acceptance separately.

## Corrections

- Image selection/paste, thumbnails and member-scoped frame persistence; short
  video local decoding into 1–4 timestamped frames, explicitly without audio.
- Sequential lazy media processing, cancellation/resource disposal, PDF worker
  cancellation, and a real seek before capturing video frame zero.
- Preserve visual context for follow-up requests. Old clients sending only an
  image/video MIME plus placeholder text must update instead of pretending that
  the model received an image. Old workspace round-trips preserve new fields.
- Header Fleur geometry now fits its 64px grid cell; short-viewport welcome
  content no longer scrolls itself out of view. Existing cursor/follow behavior
  and purchased geometry remain unchanged.
- Explicit Responses search compatibility omits only unsupported max_tool_calls;
  retains required search and source citations. Actual tool calls are accounted,
  max-three reservation/stream guard does not promise upstream billing stops.
- Streaming call counts must agree with the terminal response. Oversized or
  unpersistable model output is a controlled uncertain result, not a fake success.
- Persist new usage fields and distinguish real text Token counts from tool
  conversions. Known provider outages are diagnosed without exposing raw secrets.
- Image reserve is admin-configurable (default4096), not a claim of universal
  cost per image; completion uses provider-reported Token usage.

## Local evidence

- Main build: 110 test files / 1040 tests passed, TypeScript, renderer/API builds.
- Cloudflare TypeScript and Wrangler dry-run passed. No binding/schema migration.
- Header/welcome geometry:8 browser cases passed at1203×769 and1440×1000,
  question/heart impressions, corner movement and tool clicks; no browser errors.
- Media:7 isolated browser checks passed, including image reload/follow-up and
  video first/last pixel assertions (red then blue), cancellation and ledger,
  persistent capacity warning, actual backup export and no-charge rejection.
- Local fixture uses simulated model responses and no private data or real keys.
- Independent review found and verified fixes for search-result save400,
  underreported search calls, and paid response storage-capacity failure.

Existing workspace storage remains2MiB; capacity checks reserve1MiB for the next
bounded reply. Large existing workspaces may require export and deliberate cleanup;
no history is automatically deleted. See ai-media-2026-09-08.md for limits.

## Direct provider evidence — not installed-app acceptance

Using the user's authorized existing provider keys, both configured text models
returned200 to image input. They identified correct colors/positions in an
unlabeled self-made test image but called a rectangle a square; do not promise
perfect visual understanding or native video/audio capability.

Original search400 exactly reported Unsupported parameter: max_tool_calls.
Removing only that parameter returned a completed search and official source
citations for both models. Each sample reported8665 input /57 output Tokens.

Single streamed gpt-image-2 generation returned503 with No available compatible
accounts (request0191a1a2-cde8-4107-81e3-adfde5cdeca0). No image was returned.
Do not treat a readable model list as healthy generation, repeatedly retry paid
work, refund uncertain historical usage without reconciliation, or call AI complete.

## Release requirements

Deploy compatible backend before new clients; configure verified compatible
search and enable vision through the administrator UI, preserving keys/models/
quota. Validate Xiaoqiu's real installed upload, search, reply, persistence,
Token details and generated-file flow. Image generation remains dependent on
provider restoration. Verify remote Windows full installer and blockmap before
manifest activation; unsigned Mac remains manually installed and its automatic
manifest must remain unchanged. Back up user data and previous app before replacing
only /Applications/同频.app, and do not delete customer graphs or account history.
