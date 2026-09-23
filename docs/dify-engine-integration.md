# Dify engine integration boundary

Status: adapter and controlled tool plugin implemented and locally protocol-tested. No Dify app, plugin installation, app export, or real Dify Agent run has been verified. The self-hosted option is **not installed on this Mac**; the user explicitly ruled out local Docker installation. The preferred official Dify Cloud option requires no local Docker but has not been registered or configured. Do not modify production secrets, deploy, or push clients during this evaluation.

## Pinned compatibility

- Self-hosted Dify only: `1.17.1`, release commit shown by the official release as `8387590`. Dify Cloud is managed by Dify and is not pinned by this checkout; verify its currently exposed plugin/API behavior in the actual workspace.
- Official Agent Strategies plugin: `langgenius/agent` `0.0.47`; its manifest requires Dify `>=1.7.0`, manifest schema `0.0.2`, Python `3.12`, and declares model/tool permissions.
- Tongpin controlled tool plugin: `tongpin/tongpin_gateway` `0.1.0`, minimum Dify `1.14.2`, Python `3.12`, `dify_plugin==0.9.0` with a committed `uv.lock`. The minimum follows the official SDK compatibility table for SDK `0.9.0` rather than the Agent plugin's older minimum.
- Default strategy: `function_calling`. Use ReAct only when the selected model lacks reliable native tool calling and after a separate compatibility test.

The pins live in `deploy/dify/versions.env`. The bootstrap script clones the exact release tag and refuses an unexpected commit. It does not fetch “latest”.

## Runtime topology

```text
Tongpin client
  -> Tongpin authenticated task/quota gateway
  -> DifyEngineAdapter (one decision engine for the run)
  -> Dify Agent app + official Agent strategy
  -> Tongpin Gateway Dify tool plugin
  -> Tongpin internal controlled-tool route
  -> existing Tongpin authorization, asset ownership, idempotency and ledger services
```

The controlled-tool design never sends Tongpin-owned media-provider credentials to Dify and never lets Dify execute media tools directly. Dify-hosted **model** calls are a separate choice: they use either Dify's included model credits or a model-provider key configured server-side in the Dify workspace, as described below. The outbound Agent request carries an immutable task binding and a short-lived tool capability. The plugin exposes only `tool_name` and strict `input_json` to the model; tenant, user, conversation, run, attempt, asset ids, and authorization are manually bound runtime parameters. The plugin calls `/api/dify/tools/invoke` with both `X-Dify-Tool-Secret` (deployment service credential) and `Authorization: Bearer <per-run-grant>`. The grant is not copied into the JSON body. Both Node and Cloudflare reject either missing or invalid credential before tool execution.

The plugin derives a stable `toolCallId` from the immutable binding and canonical tool arguments. The Tongpin gateway scopes it by tenant/user, atomically reserves it, replays successful results, rejects changed parameters, and freezes a parent run after an unknown side-effect outcome. An interrupted Dify event stream is `unknown`; the adapter never silently falls back to the self-built engine and never submits the run again.

## Main-service integration contract

The owning task service must provide these pieces; they intentionally remain outside the adapter:

1. Select `engine=dify` once when creating the immutable run snapshot. Do not run `runBackgroundAgentCycle()` as a second planner for that run.
2. Issue a signed `DifyToolGrantClaims` token containing tenant/user/conversation/run/attempt, allowed tools, exact asset ids, budget version, maximum points, and expiry.
3. Persist Dify `task_id`, `message_id`, and `conversation_id` against the Tongpin run/attempt before publishing events.
4. Implement `DifyToolCallStore.reserve()` as one atomic database operation: enforce uniqueness for `(tenant_id,user_id,tool_call_id)` and return `run_blocked` when the same tenant/user/run has an unknown outcome. A separate preflight query is not sufficient because it permits a race.
5. Wire the callback to an independent Dify service credential and the approved per-run grant; the route is implemented but defaults to disabled when the credential is absent. Create `DifyToolExecutionContext` from verified grant claims rather than trusting request JSON.
6. The injected executor must revalidate tool permission, current budget version, asset ownership, and provider capability; reserve/settle each child call in the existing ledger and return exactly one ledger entry. Parent aggregation must not charge those child calls again.
7. Map `DifyEngineEvent` into the shared run-event store. `agent_thought` is treated only as tool lifecycle metadata; hidden thought text, tool input, observation, credentials, and private URLs are not exposed.

`deploy/dify/app-contract.json` lists the exact required app inputs and bound tool fields. After the real plugin and model are installed, create the Agent/advanced-chat app in Dify Studio, bind every form parameter to the matching input, publish it, export the resulting DSL, and record the actual `plugin_unique_identifier` (including its package hash). A hand-written DSL is intentionally not claimed as importable evidence because Dify generates installation-specific plugin identifiers and model bindings.

## Official Dify Cloud option (evaluation only)

Keep Tongpin's authenticated Cloudflare Worker/Durable Object backend and its own member accounts, quota, assets, and usage ledger. An enabled, immutable Tongpin run could call a published Dify Cloud Agent/Chatflow app through `https://api.dify.ai/v1` using an app-scoped key stored only in a server-side secret binding. One app key can serve many end users; Tongpin must authenticate the request and derive a stable opaque `user` value scoped to the Tongpin tenant/member, because Dify does not authenticate that field. Persist Dify's returned conversation/task/message/workflow IDs against the original Tongpin run. Never expose the app key to the desktop client. A Dify response or model usage record is not, by itself, a Tongpin ledger settlement or proof that a media tool delivered an artifact. Long-running work needs persisted Durable Object task state and explicit resume/reconciliation; a single in-memory Worker request is not a durable job queue.

Dify Cloud must have an actual account/workspace, a published app, a configured model, a tested Agent strategy, the required tool plugin, and a scoped app key. Its official Integrations documentation supports private local `.zip` uploads, but our exact plugin package and callback still require live acceptance. Prefer a Chatflow with an Agent node for a conversational task: unlike a one-shot Workflow, it has conversation continuity and a workflow-run ID that can be used to reconcile a dropped stream. **The current adapter parses this ID but does not persist it or implement Dify's stream-resume API**; that is a release blocker, not an already available recovery path. The plugin would call the existing public Tongpin callback route under separate deployment and per-run credentials; direct media provider calls from Dify would bypass Tongpin approval and accounting and are out of scope. Cloud network reachability, plugin support, callback credentials, data handling, rate limits, and a real no-fee multi-step run all require live verification. No Cloud account, subscription, plugin, app key, secret, or production configuration has been created in this checkout.

If Dify Cloud calls the model directly, its model-provider key is stored in Dify Cloud's server-side, workspace-shared model configuration, not solely inside Tongpin's Worker. Keeping a provider key exclusively with Tongpin would require a separately designed and tested Tongpin model gateway. Neither design puts a provider key in the member client. Dify's API `user` isolates that app's user conversations/files, but does not isolate workspace-level models, tools, or admin logs between organizations. Because Dify Cloud is a separate processor and its terms restrict sensitive personal data, minimize personal data in `query`, `inputs`, tool outputs, and logs and confirm the organization's data-handling requirements before sending production conversations or customer-map content.

### Registration, configuration, and cost gates (2026-09-23)

1. The workspace owner registers an official Dify Cloud account, reviews and accepts its Cloud Terms, and starts with the free Sandbox; no Docker, subscription upgrade, provider key, or production customer content is needed for account setup. The workspace owner keeps the login and recovery factors private.
2. In that workspace, first check the available model and integration permissions, then create a non-production Chatflow with an Agent node and its official strategy. Package and privately upload the Tongpin Gateway plugin only after reviewing its requested permissions; confirm that this exact plugin works in the Cloud workspace before claiming tool execution.
3. Publish the app, create its app-scoped API key, and later put it in a Tongpin Cloudflare Worker secret only as part of an explicitly approved deployment. The member client never receives it. Any separate plugin callback credential is also a server-side secret. Tongpin itself authenticates the member, derives an opaque `user` from tenant plus member, authorizes each tool, and remains the quota/ledger source of truth.
4. For a no-fee workflow test, use Dify's included model credits with synthetic data and a small, pre-agreed call cap. Sandbox currently lists 200 message credits, 5 apps, one Dify workspace builder, and 5,000 API calls/month; a model response consumes a model-dependent number of credits, so 200 credits are not necessarily 200 chats. If those credits do not cover the chosen model, stop before entering a billable provider key. Professional is listed at US$59/workspace/month (US$590/year) and Team at US$159/workspace/month (US$1590/year), excluding applicable taxes. These are optional plan prices, not a requirement inferred from Tongpin member count. BYOK model calls, media-provider calls, and incremental Cloudflare usage are separate potential costs; their budgets must be approved before live tests.
5. Dify Cloud Terms §2.1.3 restrict using the service to develop a product or service competitive with Dify, and §2.1.4 restricts sensitive personal data/high-risk activities. This is not a finding that Tongpin violates the terms. Before customer-facing production traffic, confirm the specific embedded-workflow use case and data terms with Dify rather than treating self-hosted license text as the Cloud contract. Dify workspace seats are builders/admins, not automatically every Tongpin API end user.

No account, purchase, provider key, Cloudflare secret, production deployment, or client update is authorized by this evaluation alone.

## Local self-hosted setup and verification

```bash
scripts/dify/check-prerequisites.sh
scripts/dify/bootstrap-local.sh /absolute/development/path
# Review Dify docker/.env and license scope first.
TONGPIN_DIFY_LICENSE_APPROVED=1 scripts/dify/bootstrap-local.sh /absolute/development/path --start
```

Then initialize the local Dify console, install official `langgenius/agent` exactly at `0.0.47`, package/install `deploy/dify/plugins/tongpin_gateway` with the official Dify plugin CLI, configure only the gateway URL/service credential, create the Agent app, and export its DSL. The Node local callback URL is `http://host.docker.internal:4318/api/dify/tools/invoke`; a remote Worker must use its own HTTPS origin with the same path. Set `DIFY_TOOL_ENABLED=true`, `DIFY_APP_ID` and a random `DIFY_TOOL_SECRET` of at least 32 UTF-8 bytes in the Tongpin runtime; enter that same secret as the plugin's `gateway_secret`. Do not put it in the browser or a model prompt. Missing/weak service credential disables grant issuance and callbacks. Verify without printing secrets:

```bash
DIFY_BASE_URL=http://127.0.0.1 DIFY_APP_API_KEY=... node scripts/dify/verify-runtime.mjs
```

The health script deliberately reports only reachability and expected pins. Installation evidence additionally requires healthy Dify containers, the console-reported full plugin unique identifiers, exported DSL, one real no-cost multi-step tool run, its Tongpin run/tool/ledger records, and a successful duplicate/cross-tenant rejection. Mock or protocol-fixture tests do not satisfy that evidence.

## License boundary

Dify's self-hosted platform repository uses a modified Apache 2.0 license. It permits commercial backend use, but requires written authorization/commercial licensing for a multi-tenant **Dify source-code deployment**, and explicitly defines one Dify tenant as one **Dify workspace**. Several Tongpin members using one Dify app through distinct API `user` values are not, solely for that reason, several Dify workspaces. The self-hosted license also restricts altering Dify frontend branding; the official plugins repository is Apache 2.0.

The official Dify Cloud service is governed by its own cloud Terms of Service and chosen subscription, not by assuming that every Tongpin member needs a separate self-hosted Dify tenant or a Dify workspace seat. If Tongpin later gives each independent organization its own Dify workspace, assess that actual topology separately. For customer-facing embedded use, confirm the applicable Cloud terms, data/privacy obligations, plan limits, and any negotiated terms with Dify before a paid production rollout. This repository does not remove Dify branding, create accounts, buy resources, or start a production deployment.

## Evidence from this checkout

- `docker` command: unavailable.
- Local probes at ports 80, 3000, 5001, and 8080: no Dify service; port 4318 is the existing Tongpin development backend.
- TypeScript protocol tests cover fragmented SSE, multi-step tool events, task binding, no secret/tool payload disclosure, disconnect-as-unknown, no retry/fallback, tenant isolation, same-ID replay, changed-input conflict, unauthorized/cross-tenant assets, budget rejection, and run freeze after unknown outcome.
- Python plugin tests perform a real localhost HTTP round trip and verify stable tool-call IDs, both authentication headers, nested error codes, and input/URL rejection. A Node fixture additionally invokes the actual Python client against the mounted Tongpin callback; Worker fixtures verify approved callbacks and single ledger settlement. These are local protocol tests, not a Dify installation or production Agent run.

## Official references

- Dify self-hosted Docker Compose: https://docs.dify.ai/en/self-host/deploy/quick-start/docker-compose
- Dify releases: https://github.com/langgenius/dify/releases/tag/1.17.1
- Dify platform license: https://github.com/langgenius/dify/blob/main/LICENSE
- Official Agent plugin manifest: https://github.com/langgenius/dify-official-plugins/blob/main/agent-strategies/cot_agent/manifest.yaml
- Official Agent plugin source/license: https://github.com/langgenius/dify-official-plugins/tree/main/agent-strategies/cot_agent
- Dify Python Plugin SDK compatibility table: https://github.com/langgenius/dify-plugin-sdks
- Official Dify Plugin CLI: https://docs.dify.ai/en/develop-plugin/getting-started/cli
- Dify Cloud API key and end-user identity: https://docs.dify.ai/en/api-reference/guides/get-started
- Dify Cloud end-user identity: https://docs.dify.ai/en/api-reference/guides/end-user-identity
- Dify Cloud integrations and private ZIP uploads: https://docs.dify.ai/en/cloud/use-dify/workspace/plugins
- Dify streaming and Chatflow recovery: https://docs.dify.ai/en/api-reference/guides/streaming
- Dify Cloud Terms of Service: https://www.dify.ai/legal/terms-of-service
- Dify Cloud pricing and credit rules: https://dify.ai/pricing/dify-cloud
- Dify Cloud model-provider key scope: https://docs.dify.ai/en/cloud/use-dify/workspace/model-providers
- Dify Cloud workspace member roles: https://docs.dify.ai/en/cloud/use-dify/workspace/team-members-management
- Cloudflare Worker secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Cloudflare Worker limits: https://developers.cloudflare.com/workers/platform/limits/
