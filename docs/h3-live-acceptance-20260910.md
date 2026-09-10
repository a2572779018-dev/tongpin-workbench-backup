# H3 single authorized live acceptance — 2026-09-10

## Authorization and scope

User explicitly approved exactly one 15-second video using the existing `同频-H3-服务端` token. No top-up, no automatic POST retry, no second video. This tests the actual H3 adapter against 75api from this Mac; it is not an installed-app or Cloudflare production-path acceptance claim.

## Submission

- Read-only GET `/v1/models`: succeeded; `minimax_h3` present.
- One POST `/v1/videos`: HTTP 200, submitted at `2026-09-10T03:54:55.003Z` (11:54:55 HKT).
- Task: `task_PDm5AduvFrvSzQinyQXlF4RcJJJfVWGa`.
- Parameters: `minimax_h3`, 15 seconds, 768p, 16:9. Generic orange-cat/window prompt; no user media or sensitive data uploaded.
- Secret read from an authorized UI copy into process memory only; system clipboard cleared immediately. No key value saved into this document, script, request marker or media artifact.
- A durable exclusive-create submission marker prevents accidental resubmission. Resume mode can only GET the existing task.

## Provider billing observed

- Usage log has exactly one consumption row for `同频-H3-服务端`, timestamp 11:54:55, model `minimax_h3`, **$0.750000**.
- Provider request ID: `202609100354552464695858268d9d6CFYLBbFx`.
- Request path in expanded billing detail: `/v1/videos`.
- Dedicated token remaining: **$0.25 / $1.00**, down from $1.00 / $1.00.
- Provider's expanded generic explanation still says `$0.050000 / 次` and “仅供参考，以实际扣费为准”; do not mistake that text for this 15-second video's actual total, infer an exchange rate, or quote this as a RMB price.
- No token-budget increase or recharge made.

## Outcome

- Provider completed at the 12:05:08 HKT query (roughly 10 minutes 14 seconds after submission); status `completed`, progress 100.
- Authenticated content endpoint successfully returned MP4. No second POST occurred.
- Local result: `artifacts/h3-acceptance-20260910/tongpin-h3-15s.mp4`.
- ffprobe: H.264 video, 1344×768, 24 fps, duration 15.083333 seconds; AAC audio 15.072 seconds; 8,250,751 bytes. The provider output is its native 1344×768 frame despite requested 16:9; do not describe this as mathematically exact 16:9.
- `ffmpeg -v error -i ... -f null -`: full decode passed with exit 0, no errors.
- Inspected a 3-frame contact sheet: orange cat on a sunlit windowsill, camera moves toward the cat; no obvious text or watermark in these sampled frames. Audio stream exists, but spoken/audio content was not independently transcribed.
- SHA-256: `8a985a20e045f8a12792798dbf7b6406c9e65b691bbe9a018dfd5efd68cdbd98`.
- Completion-time provider usage refresh still shows the single $0.750000 consumption record. No top-up, quota increase or repeat generation.

**Verified:** direct live H3 model permission, one paid generation, task polling, authenticated download, valid approximately 15-second MP4 and provider bill.

**Not verified/done:** generation from deployed Tongpin UI/Cloudflare backend, production video-route deployment, new desktop installer or Windows-member acceptance. NIcoNIco text-chat 403 remains a separate provider gateway issue, not solved by this H3 test.

Evidence marker (ignored generated artifact): `artifacts/h3-acceptance-20260910/submission.json`.
