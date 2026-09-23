# Dify engine integration boundary

Status: adapter and controlled tool plugin implemented and locally protocol-tested. Dify is **not installed on this Mac** because Docker/Docker Compose is unavailable, so plugin installation, app export, and a real Dify Agent run remain pending deployment verification.

## Pinned compatibility

- Dify: `1.17.1`, release commit shown by the official release as `8387590`.
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

Dify never receives provider credentials owned by Tongpin and never executes media tools directly. The outbound Agent request carries an immutable task binding and a short-lived tool capability. The plugin exposes only `tool_name` and strict `input_json` to the model; tenant, user, conversation, run, attempt, asset ids, and authorization are manually bound runtime parameters. The plugin calls `/api/dify/tools/invoke` with both `X-Dify-Tool-Secret` (deployment service credential) and `Authorization: Bearer <per-run-grant>`. The grant is not copied into the JSON body. Both Node and Cloudflare reject either missing or invalid credential before tool execution.

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

## Local setup and verification

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

Dify's platform repository uses a modified Apache 2.0 license. Its current license says commercial use is allowed, but operating a multi-tenant environment without written authorization requires a commercial license; it defines a Dify tenant as a workspace. The Dify frontend also has logo/copyright restrictions. The official plugins repository is Apache 2.0.

Because Tongpin is multi-tenant, production use is blocked pending written confirmation or a commercial license review even if one internal Dify workspace is hidden behind the Tongpin gateway. This repository does not remove Dify branding, create accounts, buy resources, or start a production deployment.

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
