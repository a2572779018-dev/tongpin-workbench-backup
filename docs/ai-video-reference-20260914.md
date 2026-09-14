# 2026-09-14 local video/UI fixes — publication paused

User explicitly paused update publication. No installer rebuild/install, update manifest change, production deployment, or paid generation was performed for these changes.

## Verified provider contract

Read the live provider Feishu document in the user's Chrome tab on 2026-09-14:
https://ecnwbwukridp.feishu.cn/wiki/M77iwzFzYiC4kUkksAXcZGZHnwd?renamingWikiNode=false

Section seven documents `minimax_h3`, POST `/v1/videos`, and `images` as an array of up to eight public image URLs in its cURL example. It does not document dedicated first-frame/last-frame controls. The UI therefore offers image references, not guaranteed first/end frames.

## Local changes

- Removed the seven right-hand helper labels from the attachment menu.
- Hide the successful connection-check card; retain real failures and retry controls.
- Added text/image-reference modes, local image selection/compression/preview/removal, and eight-image limit. Upload occurs only on generation submission.
- Account-bound image uploads use encrypted chunks and 256-bit random capability URLs valid for 24 hours. Expired rows are removed during subsequent uploads. No provider/member credentials in image URLs. Per-member temporary upload cap is 32 images.
- Public retrieval is restricted to the exact reference-image route. Job submission verifies reference ownership and expiry, constructs only the managed production URLs, and forwards the documented images array. Generation remains one POST with durable quota reservation and no automatic retries.
- Clear the pending-submit UI on definite request rejection; retain read-only reconciliation for uncertain submissions. Show separate disabled-service, missing-key, and insufficient-quota messages.

## Validation

- Full suite: 117 files, 1,144 tests passed. Includes image encryption across multiple chunks, cross-account refusal, expiration, identical-request deduplication, changed-reference conflicts, Worker restart/retrieval, and existing quota/security tests.
- Typecheck, Worker typecheck, frontend and API builds passed.
- Browser fixture at port 5176 blocks real network calls. Verified local PNG selection, compression/thumbnail, required prompt/image validation, simulated submission and queued-state disabling. This is not a real generated-video acceptance.

## Still outstanding

- Installed app is v0.1.40 logged in as member 小秋. Screenshot shows video disabled. Requested switch to administrator to inspect saved video settings/key/points; no reply yet at time of this note. Do not auto-enable from secret presence or silently choose quota conversion.
- Reference-image generation needs deployed route accessibility plus a separately authorized paid live test. The earlier one-video spending authorization was already consumed on September 10; do not reuse it.
- Exact first/end-frame control needs an explicit supported provider contract; two reference images do not establish that capability.
- Keep changes local until the user resumes publication.
