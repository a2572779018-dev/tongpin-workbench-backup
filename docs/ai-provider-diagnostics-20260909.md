# AI upstream 403 diagnostics — 2026-09-09

## Scope

Server-only diagnostic deployment for the Windows member's fresh-message HTTP 403 failures. This does not establish or repair the upstream provider's underlying refusal. Existing v0.1.39 clients receive the new server error message on new requests. No installer, release manifest, quota, provider credential, allowlist, database schema or security-control changes.

Preserve the independent, unshipped reply Markdown-rendering work in the checkout. Its desktop UI changes are not part of this Worker deployment.

## Behavior

- HTTP 401 / known `invalid_api_key`: authentication failure.
- HTTP 403 with known permission/model code: model/group permission refusal.
- HTTP 403 with `cf-mitigated: challenge`, or recognized HTML block template plus Cloudflare header evidence: security gateway block.
- Other HTTP 403: access denied, reason not established. A Ray ID alone is not evidence of blocking.
- Retain fixed-enum response kind, fixed allowlisted code/param, gateway signal and strictly shaped Cloudflare Ray ID in the existing request/usage diagnostic fields. No arbitrary error text, headers, HTML, prompt, API URL or credentials retained or logged.
- Keep 16 KiB error-body cap. Oversized/interrupted errors preserve HTTP status and any safe header evidence.
- Preserve current accounting and idempotency: explicit HTTP 403 rejects release the local reservation; 5xx/timeouts remain uncertain. No automatic retry or billing-policy change.
- Old failed request IDs retain their historical diagnosis; a new member request is required for new evidence.

Reference: https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/

## Release

Previous production Worker version: `2db32ca9-49c2-4e23-87c1-dc9496cf2b68` (100%, verified before deployment).

Deployed at 2026-09-09 20:22 Hong Kong time:

- Worker version `aa597464-d48b-4f8d-b9ba-1fe904b6c016`, tag `ai-403-diagnostics`, verified active at 100% with `wrangler deployments status`.
- 111 test files / 1063 tests passed with one worker, including real workerd transport + SQLite restart diagnostic persistence and rejection billing tests.
- `npm run typecheck`, `npm run typecheck:cloudflare`, `npm run cloudflare:check`, and `git diff --check` passed.
- Production `/api/health`: HTTP 200, `ok: true`, Durable Object SQLite and websocket service healthy.
- Unauthenticated `/api/ai/status`: HTTP 401, access control intact.
- Windows `latest.yml` unchanged at v0.1.39, existing SHA-512 and size 110118496 unchanged. No installer was uploaded or installed.
- Deployment used `--keep-vars`; no secret operations, account configuration writes, quota changes or paid provider calls were performed.

Pending: have the affected Windows member send one NEW message after deployment, then inspect its stored diagnostic. Historical requests keep old evidence. The new diagnostics do not mean the Windows conversation problem has been verified fixed.

Rollback target remains the prior version above; no schema migration was made. Preserve secrets/bindings and inspect current deployment before a rollback. Do not roll back automatically based solely on a new upstream 403.
