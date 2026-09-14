# Tongpin 0.1.41 release verification

## Source and build

- User explicitly requested publishing 0.1.41, activating the Windows update channel, replacing the local Mac app, and adding an AI navigation icon.
- Source/tag: `5e8dd7a85e12034ddccf068cee7d0d52d60d5f26`, `v0.1.41`.
- Local verification: 118 test files / 1150 tests passed; application and Worker type checks, renderer/API builds, Worker dry run passed.
- GitHub Actions run `34825794861`: quality, Windows packaging, universal macOS packaging, and publication succeeded. The first Windows attempt hit a 10-second test setup timeout; rerunning the failed job passed without skipping tests or changing assertions.
- GitHub release `388264269` published at `2026-09-14T09:19:04Z` with eight assets.

## Backend and configuration

- Worker version: `6a4a9794-09dd-490f-ba6c-7f5f2a8dd47d`.
- Production health returned 200, unauthenticated videos returned 401, unknown public video reference returned 404.
- Video generation enabled via administrator UI, existing encrypted key retained, quota configured as 750000 points per video. No additional paid video generation was submitted.
- Quick Auto / deep Astra implementation is included, but the live model selection was not saved: the app was back in member mode. Administrator switching was requested separately. Do not describe the code deployment as proof that this configuration is active.

## Mac installation

- DMG: 232118545 bytes; GitHub/local SHA-256 `91cf777c6eb49b59ab48244f7ce89520109cc28126a79dbb9adefb5e05df4bb7`.
- `hdiutil verify` passed. Mounted read-only; bundle version 0.1.41, x86_64 + arm64, 12 required ASAR entries and production endpoints verified.
- Quit old app, moved it to `/Users/sam/.Trash/同频-0.1.40-before-0.1.41.app`, copied the verified bundle to `/Applications/同频.app`.
- Installed/source ASAR SHA-256 matched: `40f81244386212293d422f6374dc3cd9cf58cad9763f7662b998c884846328d3`.
- Native UI launched as 0.1.41; member account and existing tasks, two projects, and conversations restored.
- Verified AI navigation sparkle icon visually; successful-connection card removed; attachment menu secondary descriptions removed; video dialog enabled, image-reference mode shows an upload control for up to eight images and accurately discloses that precise first/last-frame control is unsupported.
- Application Support and Keychain were not modified. No Gatekeeper bypass was needed.
- macOS automatic-update manifest must remain at 0.1.28; this unsigned build is installed manually.

## Windows artifact

- EXE: 110420858 bytes; GitHub/local SHA-256 `c0e9dca7669eaa8b5b6d73dddc6ad8f9e5dd523b2df80af24747cfc3348b74fb`.
- Blockmap: 117369 bytes; SHA-256 `0a313fc951daa8e5654e9a4765ff156a8f2d6f396a179c87a41147bd76190e48`.
- `latest.yml`: 967 bytes; SHA-256 `69c7ed482b526157e4519871a82cbc83eb56019cb8bced1cdc198df8b5afffe4`.
- All three files independently downloaded from the exact successful tagged release and verified against GitHub digests; publisher local manifest/SHA-512 checks passed.
- Uploaded EXE and blockmap, verified every byte remotely before activation, then performed a second full remote verification before uploading `latest.yml`.
- Public `https://notify.samhubs.com/releases/latest.yml` now returns 0.1.41, exact 110420858-byte EXE, and SHA-512 `iKZuTBJVOAqQybI72Icqsn/llXFSJrNS7ErGXLoLOskLA/4lanIhqfAA7l2Oolvyvvuot/YzfzImfW1dLUc3PA==`.
- The update channel is available; this is not proof of installation on every Windows member computer. Installed clients check approximately eight seconds after launch and every thirty minutes thereafter.
- Independent post-activation Windows verifier passed all 27 chunks: exact size, SHA-512, Range support, release notes/version, and closed unauthenticated upload endpoint.
- Mac public-DMG readback passed all 222 one-MiB ranges: exact 232118545 bytes and SHA-256 matched the verified GitHub DMG. The initial larger-range verification timed out; the complete smaller-range rerun passed.
- Mac manual download: `https://notify.samhubs.com/releases/Tongpin-0.1.41-mac-universal.dmg`. The unsigned macOS automatic-update manifest remains at 0.1.28.
- Final production health remained healthy at `2026-09-14T09:48:38.467Z`.
