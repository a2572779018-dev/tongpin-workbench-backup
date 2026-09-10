# 2026-09-10: 403 follow-up and 75api H3 integration

## Earlier investigation (before token authorization)

- User reports a NEW Windows request now displays the deployed `AI_PROVIDER_GATEWAY_BLOCK` message. This is not proof that the upstream block is resolved. Need the specific new request's safe diagnostic/Ray ID from the admin ledger for service-provider support.
- The app is currently signed in as member 小秋, not admin. Requested admin switch; did not extract credentials or switch accounts without the user's input.
- Shared chat service reads the global provider row on each new request. Added a regression demonstrating rotation applies to both members, while quota remains per-member. No per-member NIcoNIco keys are needed by Tongpin's architecture.
- Read the linked Feishu **好漫剧 API 对接文档**, section 七、minimax_h3 视频生成. The current 75api account is logged in, but 令牌管理 is empty with no search filters. Requested explicit authorization to create a restricted token for Tongpin; none created so far.

## Provider contract observed

Source: https://ecnwbwukridp.feishu.cn/wiki/M77iwzFzYiC4kUkksAXcZGZHnwd?renamingWikiNode=false

- Base: `https://www.75api.com`; bearer API key, not the NIcoNIco text key.
- Submit: POST `/v1/videos`, model `minimax_h3`.
- `seconds`: STRING `5` through `15`; resolution `480p` or `768p`; aspect_ratio `16:9` or `9:16`; prompt.
- Supports optional public HTTP image URLs (up to 8), audio URLs (up to 3). The first adapter explicitly rejects references until a consent-aware upload flow exists; no silent uploads.
- Query: GET `/v1/videos/{id}`. Observed statuses queued, processing, completed; progress numeric 0–100.
- Content: GET `/v1/videos/{id}/content`, bearer authentication; returns a video stream.
- In the documentation query examples, `id` and `task_id` sometimes differ. Canonical returned `id` forms the resource path. Ignore arbitrary `video_url` to avoid forwarding credentials to a supplied third-party URL.
- The generic pricing card incorrectly lists `/v1/chat/completions`, while dedicated H3 docs use `/v1/videos`. Use dedicated video contract.
- Pricing card says `$0.050 / 次`; its description says `5分钱一秒`. Do NOT infer an actual monetary charge or hard-code a per-video debit from this inconsistency. Verify actual provider billing before a paid acceptance call. No balance top-up or paid video generation was made this turn.

## Implemented locally (not released)

`server/ai/videoProvider.ts`: bounded submit/query adapter, string duration, strict model parameters and task IDs, sanitized errors, no automatic resubmission, canonical content endpoint. Test fixture only. Added `video` operation to shared diagnostic type and prefix.

This is NOT a complete or user-accessible video feature yet. Remaining: independent encrypted admin video settings; per-member durable jobs and quota reservation/reconciliation; capped polling; authenticated video streaming/storage; composer UI/history; account isolation and restart tests; live paid acceptance; desktop packaging/release. Do not deploy a partial UI or claim generation works.

## Required external steps

1. Admin ledger access to retrieve fresh Windows error correlation ID.
2. NIcoNIco operator investigates its security gateway rule. Do not bypass the challenge, proxy around the block, disable security or rotate keys speculatively.
3. Approval / user creation of a restricted 75api token, secure server-side configuration, and confirmed small acceptance-test spending cap.

## Authorized follow-up — 2026-09-10 11:27 HKT onward

- User switched installed Tongpin to administrator and explicitly authorized creation of a Tongpin-only H3 token and encrypted server storage.
- Created `同频-H3-服务端` in 75api. Restricted model: `minimax_h3` only; unlimited quota disabled; platform token cap $1.00; expires 2026-10-10 11:26:41 HKT. No top-up. Token value was not logged or written into source/client files.
- Stored as Worker encrypted Secret `TONGPIN_H3_API_KEY` using Wrangler stdin. Secret change deployment: `9ef77346-d4e3-44b0-978a-a01a9cd5c478`, 2026-09-10T03:27:42.921Z. `/health` HTTP 200 afterward. This deployed the secret, NOT the local new video routes or UI.
- A paid 15-second acceptance request has NOT been sent. Awaiting user's explicit one-video test approval because the provider price descriptions conflict. A secret existing is not proof that a generation or provider model test passed.

### Confirmed Windows gateway evidence

Read the affected member's new requests through installed administrator AI usage ledger. Both failed on `gpt-5.6-sol`, deep mode, with zero charged usage and released reservation:

| HKT time | Tongpin request ID | Provider Ray ID |
| --- | --- | --- |
| 2026-09-10 11:07:00.620 | 67301553-9d18-4cf8-b67b-ad6c0f6c9dfe | a38b3850ee2efb86-SIN |
| 2026-09-10 11:06:45.224 | bcfcbd89-3732-4851-b185-6c78d7611e8e | a38b37f0999cfb86-SIN |

Both safe diagnostics: operation `chat`, HTTP 403, category `gateway_block`, billing `rejected`, responseKind `html`, gatewaySignal `cloudflare_block_page`. This is provider-edge blocking, not proof of an invalid key or member quota failure. Provider operator investigation is still required. No bypass attempted; no support message sent.

### Local implementation completed, not production release

- Independent admin video settings/test and an additive durable `ai_video_jobs` table; existing chat settings untouched.
- Account-bound generation/query/content routes, per-member quota reservation, idempotent submit, no automatic paid retries, encrypted original-key snapshots, bounded polling and MP4 streaming.
- Unknown submission/long-stuck task becomes pending administrator reconciliation, not a false success or automatic refund/retry. Explicit rejected calls release reservation. Same job cannot settle twice.
- Member composer plus-menu opens a standalone H3 video form and task history; progress/reopen recovery, authenticated preview/download. Administrator can enable and set conversion points, test model permission without generation, and reconcile uncertain costs.
- Video conversion is recorded separately from text tokens. Reference-image/audio generation is not implemented; text-to-video only, 5–15 seconds.
- Unit/integration tests use synthetic transport fixtures. Isolated browser fixture on port 5176 explicitly blocks real service calls; its queued/completed cards are NOT live generation evidence.
- Pending: real provider model test, one authorized paid acceptance video with actual bill/MP4 verification, desktop release/install and Windows external validation. Do not report these as done.

### Verification at 11:48–11:50 HKT

- `npm run typecheck` and `npm run typecheck:cloudflare`: passed.
- `npm test`: 113 files, 1,106 tests passed (includes Worker runtime, role/account guards, duplicate submit, stale recovery and quota tests).
- `npm run build:web`, `npm run build:api`: passed.
- `npm run cloudflare:check`: dry-run passed; no video code deployment performed.
- Actual member modal inspected in isolated browser fixture at 1280×720: no overflow, disabled empty submit, queued task disables additional generation, completed task survives closing/reopening modal. Synthetic data only, no real MP4 or provider charge.

## Later live approval and result

User subsequently authorized exactly one 15-second test. Direct H3 adapter acceptance succeeded: one POST, provider completion after approximately 10 minutes, authenticated MP4 download and full decode passed (15.083333 seconds, 1344×768, H.264/AAC). Actual provider consumption $0.750000; dedicated token remaining $0.25. See `h3-live-acceptance-20260910.md` for task ID and evidence. This supersedes the earlier “paid test pending” status only; production video deployment, installer publication and Windows-member verification are still not done.
