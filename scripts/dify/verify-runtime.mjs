import { readFile } from "node:fs/promises";

const baseUrl = process.env.DIFY_BASE_URL?.replace(/\/+$/, "");
const apiKey = process.env.DIFY_APP_API_KEY;
if (!baseUrl || !apiKey) {
  console.error("DIFY_BASE_URL and DIFY_APP_API_KEY are required; values are never printed.");
  process.exit(2);
}

const contract = JSON.parse(await readFile(new URL("../../deploy/dify/app-contract.json", import.meta.url), "utf8"));
const endpoint = `${baseUrl}${baseUrl.endsWith("/v1") ? "" : "/v1"}/info`;
const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
if (!response.ok) {
  console.error(`Dify app health failed: HTTP ${response.status}`);
  process.exit(1);
}
const info = await response.json();
console.log(JSON.stringify({
  reachable: true,
  appName: typeof info.name === "string" ? info.name : null,
  expectedDifyVersion: contract.difyVersion,
  expectedAgentPlugin: `${contract.agentPlugin.id}:${contract.agentPlugin.version}`,
  expectedToolProvider: `${contract.toolProvider.id}:${contract.toolProvider.version}`,
  note: "Health only; this does not prove plugin installation or a completed Agent run.",
}, null, 2));
