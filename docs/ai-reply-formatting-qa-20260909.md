# AI reply formatting verification — 2026-09-09

Scope: fix assistant Markdown display; investigate (not change) the reported Windows HTTP 403. No provider credentials, production conversations, quotas or release manifests were changed. This is a local code/build verification, not an installed-app release acceptance.

## Rendering changes

- Assistant replies render emphasis, headings, ordered/unordered lists, quotations, tables and code with react-markdown + remark-gfm.
- A narrow text-node repair tolerates paired bold markers with trailing spaces or Chinese punctuation. Code and deliberately escaped markers stay literal. Persisted content and copy payloads are unchanged.
- Inline links reuse the existing Electron AI source opener. Only absolute HTTP(S) URLs without embedded credentials are accepted. Raw HTML is not enabled, and Markdown images become links rather than automatic remote requests.
- The complete syntax tree is parsed once per content change. The existing timed playback reveals formatted text locally, without reparsing partial Markdown each tick. Historical user messages and errors remain plain text.

## Checks

- `npm run typecheck`: passed.
- Targeted Markdown and chat performance tests: 8 passed.
- First parallel full test run: 1044 passed, two work-report route tests failed (ECONNRESET / missing report status). The unchanged work-report suite passed alone; full serial rerun `npm test -- --maxWorkers=1`: 111 files / 1046 tests passed.
- `npm run build:web` and `npm run build:api`: passed.
- `git diff --check`: passed.
- Browser fixture `/scripts/ai-reply-preview.html`: inspected rendered emphasis, citations, list, table, quotation, literal code, and intermediate typing state. The fixture uses actual ChatMessageRow and production styles with synthetic content; it does not contact a model or use customer data. The fixture entry is not included in the production build.

## HTTP 403 findings

- The server reads the global provider configuration for each new request (`server/ai/service.ts`, `chatProvider` / `chat`; `server/ai/storage.ts`, `provider`). There is no member-local API key in this flow.
- Deep and quick modes may select different model IDs; the Windows screenshot has deep mode and search enabled.
- The upstream 401/403 message is a generic authentication/permission mapping; this message alone cannot identify the upstream rejection reason.
- `retryReply` in `src/pages/TongpinAIPage.tsx` recovers a previous request, including its stored error. The service also returns a stored error for a reused request ID. This is not a fresh generation with the new provider configuration.
- It remains unknown whether the Windows screenshot shows a newly submitted request after the key was saved. A fresh Windows message with its failure time (and mode/search settings) is needed to distinguish a persisted old error from a current upstream rejection. No Windows success or root cause is claimed.

Release state: no version bump, installer build, deployment, update push or local application replacement in this task.
