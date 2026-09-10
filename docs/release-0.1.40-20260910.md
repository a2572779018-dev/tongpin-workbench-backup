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

- Source/tag: 4c8c89b8cc869a13c00186e7c637fb9a5c8879ce, v0.1.40 pushed to GitHub main/tag.
- GitHub Actions run 34448055621: quality, Windows packaging, universal macOS packaging and publication all succeeded. Release published 2026-09-10T07:11:43Z with 8 assets.
- Worker deployed at 100%: ca067f52-9f32-4a03-843d-c6601fe1146f. GET /api/health returned 200; unauthenticated availability, member video and administrator video endpoints each returned 401.
- Windows EXE: 110419390 bytes, GitHub SHA-256 ac3edfc975590f068c41801dd9e4498a2b8830fa726651d05e2b5566a54e3704. Local manifest SHA-512 verified; versioned EXE and blockmap uploaded and fully read back before activation.
- Mac DMG: 232116952 bytes, GitHub SHA-256 0a3bfdf3e41ca257ff89204b4d7230232fc0ed26220962d94b1364c01da348e8. Local manifest SHA-512, hdiutil verification, both x86_64/arm64 and 12 required ASAR entries passed.
- Installed /Applications/同频.app version 0.1.40 and started it successfully. Installed ASAR SHA-256 fa46859ef292f3e4df7fa265a9cb2ffa9fe889220eb43031adef582c0cfda41c matches verified DMG bundle.
- Native app verification: member account remained logged in; existing tasks, two AI projects and saved conversations loaded. AI showed service connection check passed. Existing Markdown reply now has list semantics and clickable source links rather than literal Markdown delimiters.
- Old application moved recoverably to ~/.Trash/同频-0.1.39-before-0.1.40.app. Application Support and Keychain untouched. No additional generation submitted.

- Windows latest.yml activated to 0.1.40 only after a second complete remote readback. Independent post-activation verifier passed all 27 chunks, exact 110419390 bytes and SHA-512; Range support passed and unauthenticated upload endpoint remained closed (404).
- Windows public installer: https://notify.samhubs.com/releases/Tongpin-Setup-0.1.40.exe. This proves update-channel availability, not installation on every member machine.
- Unsigned macOS automatic-update manifest is intentionally unchanged at 0.1.28; local installation was manual from the verified 0.1.40 DMG.
- Mac manual installer published at https://notify.samhubs.com/releases/Tongpin-0.1.40-mac-universal.dmg. Independent public readback verified all 222 chunks, exact 232116952 bytes and matching GitHub SHA-256. No macOS auto-update manifest activation.
- Final production health at 2026-09-10T07:38:37Z remained OK; installed application version remained 0.1.40.
