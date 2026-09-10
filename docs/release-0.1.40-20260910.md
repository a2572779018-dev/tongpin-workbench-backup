# Tongpin 0.1.40 release verification

## Scope and safeguards

- Availability check, elapsed waiting/recovery, safe Markdown replies, precise provider diagnostics and administrator-controlled H3 video integration.
- Preserve existing accounts, customer maps, chat history, provider credentials and quotas. Video generation stays disabled until an administrator explicitly enables it and sets its quota conversion.
- No additional paid H3 generation: the separately authorized single 15-second test was already consumed (see h3-live-acceptance-20260910.md).
- Windows: upload and verify complete versioned artifacts before activating latest.yml. macOS: manual installation only; do not activate unsigned latest-mac.yml.

## Pre-release checks

- Local full build: 116 test files / 1137 tests passed, renderer/API build passed.
- Cloudflare typecheck and deployment dry run passed; git diff whitespace check passed.
- Production before release: health OK, Windows manifest 0.1.39, macOS manifest 0.1.28.
- Previous Worker version for rollback: 9ef77346-d4e3-44b0-978a-a01a9cd5c478. New SQL table is additive; no existing table or Durable Object identity changes.
- Provider-side security restrictions and image channel failures are not claimed fixed by this release. GET /models checks connectivity, not every inference/tool capability.

## Delivery evidence

CI, remote artifact verification, activated Windows channel and installed Mac version must each be checked separately after publishing. Pre-release checks above do not by themselves prove delivery.
