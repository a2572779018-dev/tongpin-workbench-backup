# B.AI quick Auto — local, not deployed

User requested quick mode restricted to Qwen3.8 Flash, Hy3 and MiMo 2.5; deep mode GPT-6 Astra. Publication remains paused.

Verified on 2026-09-14:
- https://docs.b.ai/llmservice/promotions-and-pricing-notices/ lists zero-Credits API offers for the three quick models, explicitly limited-time. This code does not guarantee future free pricing or automatically detect promotion expiry.
- https://docs.b.ai/llmservice/api/ limits Responses to GPT/DeepSeek. The quick pool therefore uses Chat Completions; deep uses Responses.
- Model IDs: `qwen3.8-flash`, `hy3`, `mimo-v2.5`, `gpt-6-astra`. MiMo ID also verified in the installed administrator's returned model list.

`tongpin-auto` is a local routing identifier, never an upstream model. Select it through the new admin preset button (also sets Astra/Responses/medium reasoning). Deterministic rules: image or >16,000-character context selects Qwen; coding keywords select MiMo; otherwise Hy3. No model-classifier calls or paid fallback. Preflight and submission share the same routing. The actual selected model and real token counts remain in usage records; existing member quota policy is unchanged.

Quick Auto rejects hosted web search before reservation; the UI disables it and clears stale selection when entering quick Auto. Deep search remains subject to existing administrator configuration.

Installed v0.1.40 remains configured with `gpt-5.6-sol` for both modes. Do not save `tongpin-auto` to that production backend before the new routing is deployed. No live chat generation or paid call was made.

Video admin inspection: dedicated key exists; test returned H3 model-permission success without generation. Enabled=false and per-video quota conversion is empty. Awaiting user's conversion amount before enabling; do not guess the internal charge.

## Subsequent administrator configuration

User delegated the conversion choice: “按照正常标准扣除就行了”. Set the existing flat per-video conversion to 750,000 Tongpin points and enabled H3 through installed administrator UI; server returned “视频配置已保存”. Chosen internal policy is 1 USD to 1,000,000 points using the prior 15-second $0.75 observation, not an established Tongpin-wide monetary standard or current provider price guarantee. Existing deployed code charges the same flat amount for all supported durations; this limitation was stated before saving. No member balance was deducted and no generation, recharge, release or installer update was performed. Earlier dedicated provider-token balance was only $0.25 on September 10 and has not been rechecked; enabled state does not prove sufficient upstream funds or end-to-end generation success.
