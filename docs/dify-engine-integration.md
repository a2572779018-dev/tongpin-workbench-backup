# Dify engine integration boundary

Status: adapter and controlled tool plugin implemented and locally protocol-tested. An unpublished, non-production Dify Cloud Chatflow and the official Agent strategy exist in the free Sandbox. A synthetic Agent run with Dify's built-in time tool succeeded, but the Tongpin gateway tool has no credentials and has not been invoked. The private tool plugin's attempted 0.1.1 update failed in Dify Cloud and it is currently absent from the Sandbox tool list; it must be restored before any gateway test. No app export or end-to-end Tongpin run has been verified. The self-hosted option is **not installed on this Mac**; the user explicitly ruled out local Docker installation. Do not modify production secrets, deploy, or push clients during this evaluation.

## Pinned compatibility

- Self-hosted Dify only: `1.17.1`, release commit shown by the official release as `8387590`. Dify Cloud is managed by Dify and is not pinned by this checkout; verify its currently exposed plugin/API behavior in the actual workspace.
- Self-hosted official Agent Strategies pin: `langgenius/agent` `0.0.47`; its manifest requires Dify `>=1.7.0`, manifest schema `0.0.2`, Python `3.12`, and declares model/tool permissions. The managed Cloud Sandbox currently has `0.0.48` installed instead; its version is not controlled by this checkout.
- Tongpin controlled tool plugin source: `tongpin/tongpin_gateway` `0.1.1`, minimum Dify `1.14.2`, Python `3.12`, `dify_plugin==0.9.0` with a committed `uv.lock`. The minimum follows the official SDK compatibility table for SDK `0.9.0` rather than the Agent plugin's older minimum. This is the local source version, **not** a claim that Cloud has installed it.
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

The controlled-tool design never sends Tongpin-owned media-provider credentials to Dify and never lets Dify execute media tools directly. Dify-hosted **model** calls are a separate choice: they use either Dify's included model credits or a model-provider key configured server-side in the Dify workspace, as described below. The outbound Agent request carries an immutable task binding and a short-lived tool capability. The 0.1.1 plugin exposes only `tool_name` to the model; tenant, user, conversation, run, attempt, approved request ID, asset IDs, and authorization are form parameters bound to Tongpin server-supplied app inputs. The tool payload is assembled from those bound fields, not model-authored JSON. The plugin calls `/api/dify/tools/invoke` with both `X-Dify-Tool-Secret` (deployment service credential) and `Authorization: Bearer <per-run-grant>`. The grant is not copied into the JSON body. Both Node and Cloudflare reject either missing or invalid credential before tool execution.

The plugin derives a stable `toolCallId` from the immutable binding and canonical tool arguments. For side-effecting calls, the Tongpin gateway scopes it by tenant/user, atomically reserves it, replays successful results, rejects changed parameters, and freezes a parent run after an unknown side-effect outcome. The read-only `request.get` status tool rechecks authorization and rereads the saved task on each poll, so it does not replay a stale status. An interrupted Dify event stream is `unknown`; the adapter never silently falls back to the self-built engine and never submits the run again.

## Main-service integration contract

The owning task service must provide these pieces; they intentionally remain outside the adapter:

Current wiring gap: neither the Node nor Cloudflare chat entry point imports `DifyEngineAdapter`; `DIFY_TOOL_ENABLED` gates only the controlled callback route. A fresh natural-language run cannot simply be switched to Dify because `issueGrant()` currently requires an already completed local image/video plan. The current plugin lets the model select a tool name, not author a new generation prompt; it is not yet a first-run media planner. Before enabling Dify as the decision engine, add a server-owned run authorization snapshot for explicit generation intent, asset fingerprints, media parameters, approved execution ID, configuration version and maximum cost. Let Dify propose only a bounded prompt; materialize and validate a one-use plan on the Tongpin callback before the existing media quota/ledger path executes. Keep parent model and child media reservations separate, and allow a child task past the same-conversation pending guard only when it is bound to its parent run. Keep any new engine selector deployment-owned, default-off, and immutable per run; never let the client choose the engine or run Dify alongside the existing planner.

The former member-facing `/api/ai/dify/grants` route returned the short-lived tool authorization to the browser and has been removed from the Node and Cloudflare routers. Grant creation and transfer to Dify must remain internal to Tongpin's authenticated server-side send, with no grant or app key in a member response. `DifyRemoteRunStore` now provides a local tenant/user/request-scoped journal with immutable app/attempt binding, write-once remote IDs and nonterminal reconciliation lookup, but it is **not yet wired into chat or SSE handling**. The owning service must persist remote task/message/conversation/workflow-run IDs there before publishing their events. If a POST has been sent but the first Dify event is lost, the adapter now reports an unknown, non-retryable outcome; a missing ID still cannot prove non-execution. A known workflow-run ID can later be reconciled using Dify's run-detail and resumed-event APIs, but that reconciliation has not been implemented. Never log or return raw run-detail `inputs`, because they can contain `tongpin_tool_authorization`.

1. Select `engine=dify` once when creating the immutable run snapshot. Do not run `runBackgroundAgentCycle()` as a second planner for that run.
2. Issue an opaque, short-lived token backed by stored `DifyToolGrantClaims` containing tenant/user/conversation/run/attempt, allowed tools, exact asset ids, budget version, maximum points, and expiry.
3. Persist Dify `task_id`, `message_id`, and `conversation_id` against the Tongpin run/attempt before publishing events.
4. Implement `DifyToolCallStore.reserve()` as one atomic database operation: enforce uniqueness for `(tenant_id,user_id,tool_call_id)` and return `run_blocked` when the same tenant/user/run has an unknown outcome. A separate preflight query is not sufficient because it permits a race.
5. Wire the callback to an independent Dify service credential and the approved per-run grant; the route is implemented but defaults to disabled when the credential is absent. Create `DifyToolExecutionContext` from verified grant claims rather than trusting request JSON.
6. The injected executor must revalidate tool permission, current budget version, asset ownership, and provider capability; reserve/settle each child call in the existing ledger and return exactly one ledger entry. Parent aggregation must not charge those child calls again.
7. Map `DifyEngineEvent` into the shared run-event store. `agent_thought` is treated only as tool lifecycle metadata; hidden thought text, tool input, observation, credentials, and private URLs are not exposed.

`deploy/dify/app-contract.json` lists the exact required app inputs and bound tool fields. After the real plugin and model are installed, create the Agent/advanced-chat app in Dify Studio, bind every form parameter to the matching input, publish it, export the resulting DSL, and record the actual `plugin_unique_identifier` (including its package hash). A hand-written DSL is intentionally not claimed as importable evidence because Dify generates installation-specific plugin identifiers and model bindings.

## Official Dify Cloud option (evaluation only)

Keep Tongpin's authenticated Cloudflare Worker/Durable Object backend and its own member accounts, quota, assets, and usage ledger. An enabled, immutable Tongpin run could call a published Dify Cloud Agent/Chatflow app through `https://api.dify.ai/v1` using an app-scoped key stored only in a server-side secret binding. One app key can serve many end users; Tongpin must authenticate the request and derive a stable opaque `user` value scoped to the Tongpin tenant/member, because Dify does not authenticate that field. Persist Dify's returned conversation/task/message/workflow IDs against the original Tongpin run. Never expose the app key to the desktop client. A Dify response or model usage record is not, by itself, a Tongpin ledger settlement or proof that a media tool delivered an artifact. Long-running work needs persisted Durable Object task state and explicit resume/reconciliation; a single in-memory Worker request is not a durable job queue.

Dify Cloud must have an actual account/workspace, a published app, a configured model, a tested Agent strategy, the required tool plugin, and a scoped app key. Its Integrations documentation mentions `.zip` for private uploads, while the live Cloud upload input accepts `.difypkg` and `.difybndl`; the official Plugin CLI produced a `.difypkg`, and 0.1.0 was historically installed. The 0.1.1 update failed and the tool is currently absent from the list. Tool credential validation and callback execution still require live acceptance. Prefer a Chatflow with an Agent node for a conversational task: unlike a one-shot Workflow, it has conversation continuity and a workflow-run ID that can be used to reconcile a dropped stream. **The current adapter parses this ID but does not persist it or implement Dify's stream-resume API**; that is a release blocker, not an already available recovery path. The plugin would call the existing public Tongpin callback route under separate deployment and per-run credentials; direct media provider calls from Dify would bypass Tongpin approval and accounting and are out of scope. Cloud network reachability, callback credentials, data handling, rate limits, and a real no-fee multi-step run all require live verification. No subscription, app key, secret, or production configuration has been created in this checkout.

### Live free-Sandbox checkpoint (2026-09-23)

- The user signed into Dify Cloud and the workspace UI shows **SANDBOX**. Before the synthetic run it showed 0/200 included AI message credits used; after it, 198 credits remained. This is workspace UI evidence, not evidence of a working Tongpin integration.
- Created the unpublished Chatflow **同频 AI · 沙盒验证** at `https://cloud.dify.ai/app/87f9e2ee-d575-4925-a6fb-2a8f1a9dc0e7/workflow`. Its Start node began with six inputs: tenant, user, conversation, run, attempt, and tool authorization. After the tool-contract review, added required `tongpin_request_id` (Text, max 128) and `tongpin_source_asset_ids_json` (Paragraph string, max 4096), both intended for Tongpin's server-side API call rather than browser prefill. Replaced the default LLM with a FunctionCalling Agent using the credit-backed `gpt-4o-mini`, Dify's built-in `获取当前时间` tool, and a direct reply bound to `Agent / text`. Reloading confirmed the graph persisted; Dify's checklist showed no configuration issues after the new fields.
- Installed and reopened the official Dify-certified `langgenius/agent` strategy, version `0.0.48`, in this Sandbox. Installation alone did not configure or run an Agent node; the separate synthetic preview below did call a model and the built-in time tool.
- The private `tongpin_gateway` 0.1.0 plugin originally passed four localhost unit tests. Dify Plugin CLI `v0.6.10` packaged it as a 13-entry `.difypkg` (SHA-256 `bec72508f46a846beac0a453202ad194f0f6885ee468b48df8c084eda29215c1`) after adding the CLI-required `_assets/icon.svg`. The Sandbox accepted that package and once showed **同频受控工具网关 0.1.0 / tongpin_gateway / LOCAL PLUGIN**. This was historical installation evidence, not callable or authorized tool execution. No callback URL, service secret, per-run grant, or production data was entered.
- A single synthetic Studio preview with fake tenant/user/run identifiers and no real grant asked for the current time. Dify reported a successful workflow and `Agent / text` reply; the Agent trace showed `ROUND 1` with `CALL CURRENT_TIME` and `ROUND 2`, not merely an unverified model assertion. The OpenAI provider displayed `AI 消息额度使用中`, and the workspace's included credit balance moved from 200 to 198. No paid provider key, media API, or Tongpin gateway callback was used. This validates only a Dify-internal Agent/tool loop.
- The local 0.1.1 contract now binds `tongpin_request_id` and `tongpin_source_asset_ids_json` from Tongpin-approved server inputs. Only the tool name remains model-selected; the plugin constructs `{requestId}` from the bound field. Local tests also caught and fixed a stale status-poll replay: `request.get` now reads the current result on each call while mutating tools retain idempotent reservations. This is a local fix, not a live Cloud callback test.
- Dify Plugin CLI packaged local 0.1.1 as a 13-entry `.difypkg` (SHA-256 `25fb1241bc26f39a90715b1e82214487c4b439db982612db708c4fdec921a603`). Upload validation showed the intended `0.1.0 -> 0.1.1` update, but installation failed with `can't find build instanceID with name trigger-4f0e6e56-348b-4a65-ac22-7f8c39cda273`. A subsequent install attempt failed with the same message for `trigger-f4301df8-ab54-47fd-ae5c-85cb76644004`. After a page reload, the Sandbox Tools list no longer showed the old private plugin either; a later read-only check still showed only built-in tools and two failed-install notices. **Do not infer successful installation from an accepted upload, or infer the root cause from this error alone.** Preserve the package/source, seek a specific diagnosis before another installation attempt, and verify any eventual installed version in the Tools list.
- The Chatflow is **not published** and has **no app API key**. Its Agent currently uses only Dify's built-in time tool. The private Tongpin gateway is not currently available in the Sandbox and still lacks a reachable callback URL, service secret, and approved per-run grant. The app cannot be treated as a connected Tongpin engine until plugin restoration, gateway parameter binding, main-service wiring, persisted remote IDs, quota/ledger acceptance, and no-fee end-to-end tests pass. Before creating a scoped key or sending customer traffic, review the requested access and use-case terms with the workspace owner.

If Dify Cloud calls the model directly, its model-provider key is stored in Dify Cloud's server-side, workspace-shared model configuration, not solely inside Tongpin's Worker. Keeping a provider key exclusively with Tongpin would require a separately designed and tested Tongpin model gateway. Neither design puts a provider key in the member client. Dify's API `user` isolates that app's user conversations/files, but does not isolate workspace-level models, tools, or admin logs between organizations. Because Dify Cloud is a separate processor and its terms restrict sensitive personal data, minimize personal data in `query`, `inputs`, tool outputs, and logs and confirm the organization's data-handling requirements before sending production conversations or customer-map content.

### Registration, configuration, and cost gates (2026-09-23)

1. The workspace owner registers an official Dify Cloud account, reviews and accepts its Cloud Terms, and starts with the free Sandbox; no Docker, subscription upgrade, provider key, or production customer content is needed for account setup. The workspace owner keeps the login and recovery factors private.
2. In that workspace, first check the available model and integration permissions, then create a non-production Chatflow with an Agent node and its official strategy. Package and privately upload the Tongpin Gateway plugin only after reviewing its requested permissions; confirm that this exact plugin works in the Cloud workspace before claiming tool execution.
3. Publish the app, create its app-scoped API key, and later put it in a Tongpin Cloudflare Worker secret only as part of an explicitly approved deployment. The member client never receives it. Any separate plugin callback credential is also a server-side secret. Tongpin itself authenticates the member, derives an opaque `user` from tenant plus member, authorizes each tool, and remains the quota/ledger source of truth.
4. For a no-fee workflow test, use Dify's included model credits with synthetic data and a small, pre-agreed call cap. Sandbox currently lists 200 message credits, 5 apps, one Dify workspace builder, and 5,000 API calls/month; a model response consumes a model-dependent number of credits, so 200 credits are not necessarily 200 chats. If those credits do not cover the chosen model, stop before entering a billable provider key. Professional is listed at US$59/workspace/month (US$590/year) and Team at US$159/workspace/month (US$1590/year), excluding applicable taxes. These are optional plan prices, not a requirement inferred from Tongpin member count. BYOK model calls, media-provider calls, and incremental Cloudflare usage are separate potential costs; their budgets must be approved before live tests.
5. Dify Cloud Terms §2.1.3 restrict using the service to develop a product or service competitive with Dify, and §2.1.4 restricts sensitive personal data/high-risk activities. This is not a finding that Tongpin violates the terms. Before customer-facing production traffic, confirm the specific embedded-workflow use case and data terms with Dify rather than treating self-hosted license text as the Cloud contract. Dify workspace seats are builders/admins, not automatically every Tongpin API end user.

The Sandbox account and the unpublished test Chatflow now exist. No purchase, provider key, Cloudflare secret, production deployment, or client update is authorized by this evaluation alone.

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
