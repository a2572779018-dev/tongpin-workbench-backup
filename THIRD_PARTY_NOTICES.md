# Third-party notices

## OpenSquilla routing design reference

Tongpin's bounded quick-agent router follows the documented architecture of
OpenSquilla's local turn router: each turn is classified before selecting a
permitted model, while the surrounding account, quota, approval, persistence,
and tool-result loop remains owned by Tongpin. Tongpin does not bundle or claim
to run OpenSquilla's Python gateway, ONNX model, LightGBM runtime, telemetry, or
desktop application; this avoids adding a second privileged runtime to every
member device.

OpenSquilla 0.5.4 is available at
https://github.com/TokenRhythm/opensquilla and is licensed under the Apache
License 2.0. Its documentation and project name are used here for attribution
and architectural provenance; no OpenSquilla model asset is redistributed.

## Cua Driver local computer-use runtime

`@trycua/cua-driver` 0.28.1 provides the typed, same-process desktop driver
used by the Electron main process. The dependency is version-locked; its native
platform packages are unpacked from ASAR so their N-API runtime and adjacent
dynamic library can be loaded by the signed desktop application. Tongpin does
not expose Cua Driver's generic tool surface, daemon, shell, clipboard, file, or
network capabilities to the renderer.

The package root is licensed under the MIT License:

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The selected native package also contains `cua_driver_node_runtime.node`, a
compatibility build derived from `uniffi-bindgen-react-native` 0.31.0-3 and
licensed under Mozilla Public License 2.0. Its packaged
`node-runtime-NOTICE.md` is retained. The corresponding source and deterministic
build transformation are available in the Cua repository at the matching
release tag. This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this file, one
can be obtained at https://mozilla.org/MPL/2.0/.

## Cua jev-use closed-candidate decision pattern

Tongpin's unified computer executor adapts the closed-candidate loop from the
`jev-use` example in the Cua repository: every observation produces an
immutable candidate table with complete natural-language descriptions and the
reserved `reobserve` / `abstain` choices; the Jev answer is accepted only as one
of the supplied ids and is resolved through the original table bound to that
capture; outcomes are classified as verified, refuted, unknown, abstained or
budget exhausted; a background refusal produces a distinct explicit foreground
candidate instead of a blind retry; an uncertain action is never replayed.

- Source: https://github.com/trycua/cua (`libs/cua-driver/examples/jev-use`)
- Commit: e8777e6d6a997476cc254146ade31f772c56ec48
- License: MIT, Copyright (c) 2025 Cua AI, Inc. (same license text as the Cua
  Driver entry above)
- Adapted from: `typescript/core.ts`, `typescript/jev_adapter.ts`,
  `typescript/choose_action.ts`, `typescript/run.ts`
- Adapted into: `electron/computer-agent-policy.cjs`, `electron/computer-agent.cjs`,
  `server/ai/computerExecutor.ts`, `shared/computerAgent.ts`,
  `src/features/tongpin-ai/computerExecutor.ts` (rewritten for Tongpin's
  consent, authorization, billing and Electron boundaries; no file is copied
  verbatim)

## TypeSafe System One (Jev) API contract reference

The Jev client in `server/ai/computerJev.ts` is a minimal fetch client written
against the public TypeSafe HTTP API documentation (`POST /v1/systemone`,
`GET /v1/models`). The official JavaScript SDK `@typesafe-ai/sdk` 0.6.0
(https://github.com/typesafe-ai/typesafe-sdk-js, commit
66880ccded6cb642dc1809620c2b108c33730214, MIT License) was consulted only as a
reference for request/answer shapes and error statuses; it is not a dependency
and none of its code is redistributed.

## WeChat macOS accessibility reference

The WeChat application alias (`com.tencent.xinWeChat`) and the expectation that
WeChat 4.x exposes its search box, conversation list and message input through
macOS accessibility were checked against the public notes of WeChat-MCP
(https://github.com/BiboyQG/WeChat-MCP, MIT License). No code from that project
is included.

## AI reply Markdown rendering

`react-markdown` 10.1.0 (https://github.com/remarkjs/react-markdown) and
`remark-gfm` 4.0.1 (https://github.com/remarkjs/remark-gfm) render formatted
assistant replies. Exact dependency versions are locked in package-lock.json.

Tongpin also adapts LibreChat v0.8.7 commit
`9e74cc0e57b395926122bd4062c1fcedc48ed465` source from
`client/src/components/Chat/Messages/Content/splitMarkdown.ts` and
`MarkdownBlocks.tsx` for GFM top-level block splitting and memoized completed
block rendering in the actual AI chat. The shared source-offset splitter is
now used by both the chat renderer and the settled server response descriptor;
the descriptor never duplicates response text. The local adaptation omits upstream
math/artifact directives and code/artifact index providers because Tongpin's
current renderer does not enable those features. This is a partial UI module
reuse, not an installation of the LibreChat backend or its agent/runtime.

Reply citation markers adapt the same LibreChat commit's
`client/src/components/Web/plugin.ts`, `Citation.tsx`, `SourceHovercard.tsx`
and `Context.tsx` (`src/features/tongpin-ai/replyCitations.ts` and
`ReplyCitation.tsx`): remark plugins splice custom `hName` nodes into parsed
text so each marker renders as a React component rather than HTML, a per-reply
context resolves marker numbers to sources, and a hover card shows the source
title and domain. Tongpin places markers from server-verified provider
`url_citation` offsets on the already-parsed tree instead of model-written
private-use marker characters, links only model-written `[n]`/`【n】` numbers
that exist in the reply's source list, omits Ariakit and remote favicon
requests, and makes a marker jump to the reply's numbered source list.

The reply "process" section (`src/features/tongpin-ai/ReplyProcess.tsx`,
`replyProcessModel.ts`, `stopReplyShortcut.ts`, `src/lib/aiProcessPreference.ts`)
adapts structure and state logic from the same LibreChat revision:
`client/src/components/Chat/Messages/Content/ContentParts.tsx` and `Part.tsx`
(one ordered list of typed parts rendered per kind), `ToolCallGroup.tsx`
(auto-expanded while active, collapsed to a one-line summary once complete,
with a remembered per-group user override), `Parts/Reasoning.tsx` and
`Parts/Thinking.tsx` (live vs finished thinking label and its disclosure),
`ProgressText.tsx`, `WebSearch.tsx` and `InProgressCall.tsx` (header row,
search progress and source-count wording, unfinished calls shown as not
completed once the reply stops), `client/src/store/showThinking.ts` (a
persisted per-viewer expand preference) and `client/src/hooks/useKeyboardShortcuts.ts`
(`anyModalOpen` / `isWithinOpenMenu` guards, reused for Esc-to-stop). Styling,
wording and data sources are Tongpin's own: parts come only from real run
events, the saved process record, the harness trace or linked result cards, and
LibreChat's timer-driven `useProgress` animation is intentionally not used.

LibreChat MIT License, Copyright (c) 2026 LibreChat:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The MIT License (MIT)

Copyright (c) Espen Hovlandsdal (react-markdown)

Copyright (c) Titus Wormer <tituswormer@gmail.com> (remark-gfm)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Pro 多 Agent 协作 (multi-agent orchestration)

The Pro tier's 多 Agent 协作 strategy (coordinator → concurrent sub-agents →
synthesis) is adapted source, not an installed framework: no npm dependency was
added, and all model calls still go through Tongpin's own provider transport,
quota reservation/settlement, harness trace and run journal. Selection notes:
`docs/ai-handoff/11-多Agent协作开源选型.md`.

- **LibreChat `@librechat/agents`** — https://github.com/LibreChat-AI/agents
  (package metadata: github.com/danny-avila/agents), version 3.2.46 (the
  version LibreChat v0.8.7 pins), tag `v3.2.46`, commit
  `b405dffb13ba15cbefa20e7bf4d971ce6963ec6a`, MIT License, Copyright (c) 2024
  LibreChat. Adapted: `src/tools/subagent/SubagentExecutor.ts` (`execute`: the
  child receives only its task description, the parent AbortSignal is passed to
  the child, a child error becomes a bounded result instead of failing the
  parent; `truncateErrorMessage`, `filterSubagentResult`) into
  `server/ai/multiAgentOrchestrator.ts`; `src/tools/SubagentTool.ts`
  (`SubagentToolDescription` / `DESCRIPTION_PROP_DESCRIPTION` delegation
  contract) into `server/ai/multiAgentPrompts.ts`; the `ON_SUBAGENT_UPDATE`
  lifecycle envelope into `shared/aiMultiAgent.ts` (`AiSubagentUpdate`) and the
  `subagent_update` run event in `shared/aiRunEvents.ts`.
- **LibreChat** — https://github.com/danny-avila/LibreChat, v0.8.7, commit
  `9e74cc0e57b395926122bd4062c1fcedc48ed465`, MIT License, Copyright (c) 2026
  LibreChat (license text reproduced in "AI reply Markdown rendering" above).
  Adapted: `client/src/components/Chat/Messages/Content/Parts/SubagentCall.tsx`
  (per-sub-agent card resolving running / finished / cancelled / errored, the
  `useThrottledValue` hook and `SUBAGENT_TICKER_THROTTLE_MS`, the label plus
  `dir="rtl"` ticker body that keeps the newest characters visible) into
  `src/features/tongpin-ai/MultiAgentProcess.tsx` and `multi-agent.css`.
  Details are shown inline instead of LibreChat's dialog; styling is Tongpin's.
- **OpenAI Agents SDK (JavaScript/TypeScript)** —
  https://github.com/openai/openai-agents-js, version 0.18.0, commit
  `fdaf0a66ca6e9d89498909ad7cf64745630e8afb`, MIT License, Copyright (c) 2025
  OpenAI. Adapted: `packages/agents-core/src/runner/toolExecution.ts`
  (`executeToolRunsWithConcurrency`: bounded worker pool pulling from a shared
  index, every started worker drained before returning) and
  `packages/agents-core/src/utils/abortSignals.ts` (`combineAbortSignals`) into
  `server/ai/multiAgentOrchestrator.ts` (`runWithConcurrencyLimit`,
  `combineAbortSignals`). Unlike upstream, one sub-agent's failure never cancels
  its siblings.
- **LangGraph.js** — https://github.com/langchain-ai/langgraphjs, MIT License.
  Its orchestrator-worker (`Send` map-reduce) pattern was a design reference
  only; no LangGraph code is copied or bundled.

`@librechat/agents` MIT License, Copyright (c) 2024 LibreChat:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

OpenAI Agents SDK MIT License, Copyright (c) 2025 OpenAI:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## AI reply code highlighting

`highlight.js` 11.11.2 (https://github.com/highlightjs/highlight.js) grammars
and core, driven through `lowlight` 3.3.0 (https://github.com/wooorm/lowlight),
colour fenced code in assistant replies. Only fourteen grammars are bundled
(Bash, CSS, Diff, Go, Java, JavaScript, JSON, Markdown, Python, Rust, SQL,
TypeScript, HTML/XML and YAML), in a chunk loaded on first use. The lazy
loading pattern is adapted from LibreChat v0.8.7 commit
`9e74cc0e57b395926122bd4062c1fcedc48ed465`
`client/src/components/Chat/Messages/Content/Parts/useLazyHighlight.ts`, under
the LibreChat MIT License reproduced in the previous section. Exact dependency
versions are locked in package-lock.json.

highlight.js BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

lowlight MIT License

Copyright (c) Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## AI voice input and read-aloud

The 同频 AI voice features adapt LibreChat v0.8.7 commit
`9e74cc0e57b395926122bd4062c1fcedc48ed465`
(https://github.com/danny-avila/LibreChat), under the LibreChat MIT License
reproduced in "AI reply Markdown rendering" above:

- `api/server/services/Files/Audio/STTService.js` (`MIME_TO_EXTENSION_MAP`,
  `getValidatedLanguageCode`, `openAIProvider`, `sttRequest`) and
  `api/server/routes/files/speech/stt.js`, adapted in `server/ai/voice.ts`,
  `server/ai/voiceAudio.ts`, `server/ai/voiceRoutes.ts` and
  `cloudflare/src/ai/voiceRoutes.ts`: one OpenAI-compatible
  `/audio/transcriptions` multipart request per recording.
- `api/server/services/Files/Audio/TTSService.js` (`openAIProvider`,
  `ttsRequest`) and `streamAudio.js` (`splitTextIntoChunks` and its sentence
  separators), adapted in `server/ai/voice.ts` and
  `src/features/tongpin-ai/voice/speechText.ts`.
- `client/src/components/Chat/Input/AudioRecorder.tsx`,
  `client/src/hooks/Input/useSpeechToText.ts` and `useSpeechToTextExternal.ts`
  (MediaRecorder chunks, best supported MIME type, silence monitoring,
  appending the transcript to the composer, automatic sending), adapted in
  `src/features/tongpin-ai/voice/recorderState.ts`, `useVoiceRecorder.ts`,
  `VoiceInputControl.tsx` and `voiceHooks.ts`.
- `client/src/hooks/Input/useTextToSpeech.ts`, `useTextToSpeechBrowser.ts`,
  `useTextToSpeechExternal.ts`, `client/src/hooks/Audio/useTTSBrowser.ts`,
  `useTTSExternal.ts`, `client/src/components/Chat/Messages/HoverButtons.tsx`
  and `client/src/components/Nav/SettingsTabs/Speech/ConversationModeSwitch.tsx`
  (speak/stop toggle on a message, speechSynthesis utterances, external audio
  played at the member's rate, conversation mode), adapted in
  `src/features/tongpin-ai/voice/speechPlayer.ts`, `ReadAloudButton.tsx` and
  `voicePreferences.ts`.

Tongpin's own parts are the tenant and account scope, one-time request ids,
同频点 reservation and settlement, audio container and duration checks
(WebM, Ogg, WAV, MP4), Markdown/code/citation cleaning before speech, the
Chinese system-voice preference, per-member preferences in localStorage and
the Electron microphone permission handling. LibreChat's Recoil stores,
toasts, Azure/ElevenLabs/LocalAI providers, streamed message audio and TTS
cache are not used.

## AI document processing and export

The AI workbench uses pdfjs-dist, Mammoth, PptxGenJS and JSZip through their npm
APIs. Exact versions, artifact integrity, license texts and security boundaries
are included in [AI_DOCUMENT_LIBRARY_NOTICES.md](AI_DOCUMENT_LIBRARY_NOTICES.md).
That companion notice is distributed with the application and must be retained.

## AI workspace reference screening

The following projects were reviewed as architecture and interaction references,
not installed as Tongpin's backend. This release's AI workspace, account
isolation and quota service are implemented within Tongpin. The LibreChat
GFM block, citation marker and reply-process part modules are the specific
partial reuses documented above; source from
the other four platforms is not vendored by this integration. The license
screening below records upstream LICENSE snapshots checked on 2026-09-05, not a
claim that all five have unrestricted commercial or rebranding permissions.

| Reference | Screened upstream license and condition |
| --- | --- |
| [LibreChat](https://github.com/danny-avila/LibreChat/blob/622a934a82ebf427d111922bd7c0c1560edb5730/LICENSE) | MIT; retain the required copyright and license notice when reusing code. |
| [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm/blob/27c58541bd555b8b9791ed6e2d8d7bdb252230ca/LICENSE) | MIT; retain the required copyright and license notice when reusing code. |
| [Dify](https://github.com/langgenius/dify/blob/d565802ea119de3b4aba5ec9e20e40162eef1d64/LICENSE) | Modified Apache-2.0 terms, including multi-tenant and frontend logo/copyright conditions. |
| [Open WebUI](https://github.com/open-webui/open-webui/blob/26a645f9e64914799bafa343413d95bd295cf6b7/LICENSE) | Open WebUI License, including branding-retention rules with defined exceptions. Earlier materials may retain their original licenses. |
| [LobeHub / LobeChat](https://github.com/lobehub/lobehub/blob/f25fda6de2fdae57cc54f1610d085cf8af845e95/LICENSE) | LobeHub Community License, based on Apache-2.0 with additional commercial-usage terms for developing and distributing derivative works. |

Future code reuse must be reviewed against the exact selected revision and
applicable terms, with its required notices added. These references do not imply
endorsement or permission to reuse their trademarks.

## Murmur

The member relationship-map feature is compatible with and inspired by the
relationship graph model and interaction patterns in
[Murmur](https://github.com/sgaofen/murmur), fixed at commit
`2af9c2fe17bec892ec7def00f9a4cc75d50b3c8e`.

MIT License

Copyright (c) 2026 sgaofen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The feature accepts only relationship JSON explicitly selected by the user. It
does not contain chat-database decryption, key extraction, process attachment,
or automatic upload of relationship data.

## Phosphor Icons

The relationship-map interface uses `@phosphor-icons/react`.

MIT License

Copyright (c) 2020 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## XYFlow

The relationship-map canvas uses `@xyflow/react` and `@xyflow/system`.

MIT License

Copyright (c) 2019-2025 webkid GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## GSAP

The relationship-map layout feedback animation uses GSAP 3.15.0 under the
Standard "No Charge" GSAP License:
https://gsap.com/standard-license

Copyright 2008-2026, GreenSock. All rights reserved.

## classcat

MIT License

Copyright © Jorge Bucaran <https://jorgebucaran.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Zustand

MIT License

Copyright (c) 2019 Paul Henschel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## use-sync-external-store

MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## D3 ISC components

The graph canvas bundles `d3-color`:

Copyright 2010-2022 Mike Bostock

It also bundles `d3-dispatch`, `d3-drag`, `d3-interpolate`, `d3-selection`,
`d3-timer`, `d3-transition`, and `d3-zoom`:

Copyright 2010-2021 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

## d3-ease

BSD 3-Clause License

Copyright 2010-2021 Mike Bostock
Copyright 2001 Robert Penner
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice,
  this list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific
  prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

## Liquid Orb

Earlier AI status identities vendored a subset of [LerSent001/orb](https://github.com/LerSent001/orb),
commit `047c58cc93587c21dac12183fc0fb1e4101c8e1a`. Local renderer changes limit
pixel ratio and idle frame rate, and guard asynchronous cleanup. The host adds
visibility, reduced-motion, device-loss and static-logo fallback handling.

MIT License

Copyright (c) 2026 LerSent001

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## MetalFx and Border Beam

The earlier AI welcome identity used `metal-fx` 1.0.4 from
[Jakubantalik/metal-fx](https://github.com/Jakubantalik/metal-fx), source commit
`be1bf89c63056521a4e8224f368768314c9006f7`.
The retained source tree includes the unchanged `packages/border-beam/src` files from
[Jakubantalik/Libraries.dev](https://github.com/Jakubantalik/Libraries.dev),
commit `999866f33df216dab0f8956f91c8d2e918d46328`.
Both packages carry the following license. These earlier identities and beam
are not loaded by the current AI workspace. The separate paid Fleur export is
described below; it is not covered by this MIT notice. No Avatar Lab AGPL runtime
is included.

MIT License

Copyright (c) 2026 Jakub Antalik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Metalforge Fleur character

The current AI character uses the user's purchased Fleur React + Web export
from https://metalforge.xyz/character, provided on 2026-09-07 for integration in
Tongpin. The selected pink body, yellow eyes and impression geometry come from
that export. The app adds strict types, rendering fixes, bounded pointer-follow
motion, visibility/reduced-motion pausing and account-scoped expression settings.

The export did not include an open-source license. It is not relicensed under
any MIT notice in this document; use remains subject to the user's purchase
terms. The original archive and standalone demo are not distributed as public
download assets. Only the internal application component is bundled here.
## awesome-ai-persona-skills

- Source: https://github.com/momozi1996/awesome-ai-persona-skills
- License: MIT
- Copyright: Copyright (c) 2026 moyan
- Use in Tongpin: product-safe persona catalogue patterns. Tongpin does not ship
  third-party identity claims or tool permissions as trusted system prompts.
- Catalogue (issue #26): `src/features/tongpin-ai/personaPresets.ts` holds 156
  low-authority writing/role presets in 15 categories — the 39 pre-existing
  presets plus 117 new ones rewritten in Tongpin's own words from the upstream
  `persona-skills.md` sections, `Novelists/`, `zimeiti/`, `DirectorAgents-1/`,
  `tianya-gods-framework/`, `EQ/` and the README's 永乐大典 entry. Each new
  preset records the upstream section it came from (`source`). No upstream
  prompt text is copied beyond short names; no upstream "identity" (你就是X /
  first-person claims), tool permission, script, or factual assertion is used.
- Real people: presets describe a technique, not a person. A named reference
  ("参考……笔法/手法") is used only for a short allowlist of deceased, widely
  studied authors, directors and thinkers, always with an explicit "does not
  claim to be that person or invent their words" guard. Upstream entries built
  on living people (novelists, bloggers, directors, entrepreneurs, forum
  authors) became unnamed methodology/style presets.
- Not imported: distillations of private individuals (colleague, boss, ex,
  parents, crush, friend, deceased relatives, the user's own digital clone;
  replaced where useful by generic coaching presets that never simulate a real
  person); real streamers and VTubers; divination/fortune charts, wealth-signal
  mining, wiki scraping and other entries that need tools, calculations or
  external facts (a culture-only 术数 explainer is offered instead); document
  "anti-distill" poisoning; political-leader persona skills (only a generic
  "main-constraint analysis" method is kept); the multi-agent orchestrator
  scripts (DirectorAgents and 天涯 teams are represented as single roundtable
  role presets, not agents).

MIT License

Copyright (c) 2026 moyan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## NousResearch Hermes Agent (member memory learning loop)

- Source: https://github.com/NousResearch/hermes-agent
- Commit: `d0288be5b3330d2442e3907185b8e9d0958297bb`
- License: MIT
- Copyright: Copyright (c) 2025 Nous Research
- Use in Tongpin: 同频 AI's member memory ("AI 对你的了解") ports Hermes'
  learning-loop *mechanism*, not its Python runtime. Hermes forks its Python
  agent and gives the fork a `memory` tool; Tongpin runs inside a Cloudflare
  Durable Object with an Express mirror, so the review is one journaled
  strict-JSON model call (plus at most one consolidation retry) whose
  operations are validated and applied by TypeScript code. No Hermes code,
  gateway, skills, session database or external memory provider is bundled.
- Adapted files (upstream → Tongpin):
  - `tools/memory_tool_store.py` (`MemoryStore`: character budgets counting the
    `\n§\n` delimiter, unique-substring `old_text` matching with whole-entry
    exact-match priority, whole-entry `replace`, duplicate adds as no-ops,
    all-or-nothing batches against the final budget, overflow errors instead of
    silent dropping, refusal to empty a store through a batch, pinned entries,
    `_render_block` usage header, frozen load-time snapshot and load-time
    sanitization) → `server/ai/memberMemoryStore.ts`, `server/ai/memberMemoryPrompt.ts`.
  - `tools/memory_tool.py` (`MEMORY_SCHEMA` guidance, `new_text` alias,
    unattended background-review delete gate) → `server/ai/memberMemoryReview.ts`.
  - `tools/threat_patterns.py` (strict-scope injection/exfiltration patterns,
    invisible Unicode set, NFKC folding) → `server/ai/memberMemorySafety.ts`,
    extended with Chinese patterns and a credential filter.
  - `agent/background_review.py` (`_MEMORY_ROUTING_BLOCK`,
    `_MEMORY_REVIEW_PROMPT`, post-turn review that never blocks the reply) and
    `agent/prompt_builder.py` (`build_memory_guidance`: declarative facts, not
    instructions) → Chinese reviewer instructions in
    `server/ai/memberMemoryPrompt.ts`, orchestration in `server/ai/memberMemoryService.ts`.
  - `website/docs/user-guide/features/memory.md` (two stores, capacity
    management, frozen snapshot pattern, "memory updated" notification) →
    overall design, `src/features/tongpin-ai/MemberMemoryPanel.tsx` and
    `MemoryUpdateIndicator.tsx`.
  - `tests/tools/test_memory_tool.py` → test semantics and scanner cases in
    `server/ai/memberMemoryStore.test.ts` and `server/ai/memberMemorySafety.test.ts`.
- Tongpin changes: Chinese character budgets (memory 1,000 / user 600, see
  `shared/aiMemory.ts`), per-member SQLite storage with revisions instead of
  files, per-conversation frozen snapshots with a 6-hour lifetime, member-only
  access, an administrator switch/tier/price, and billing through the existing
  quota ledger only when memory actually changes.

MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## FormKit AutoAnimate

- Source: https://github.com/formkit/auto-animate
- Version: 0.9.0
- License: MIT
- Use in Tongpin: lightweight message-list entry and layout transitions. The
  library's default reduced-motion behavior is preserved.

## AI-employee office visualization (code reference)

`src/features/tongpin-ai/agentOffice/` — the Pixi.js scene that shows the Pro
tier's multi-agent coordinator and its workers as small animated office
employees — adapts source from Munder Difflin, a local-first multi-agent
harness, commit `a7452eea45d3c37dfa6f352c10a2adaf0a307c25` (v0.4.6), available
at https://github.com/chaitanyagiri/munder-difflin. The following were ported
or adapted from its `src/renderer/src/scene/office/` directory: the WebGL
context-loss detection and bounded-retry recovery logic (`glRecovery.ts`), the
camera fit/scale math (`Camera.ts`), the thought- and tool-bubble UI widgets
(`ThoughtBubble.ts`, `ToolBubble.ts`), the coordinator/worker envelope-flight
animation (`MessageEnvelope.ts`), and the general approach of the procedural,
pixel-buffer-based portrait engine used to draw each employee's bust.

Two things from the same upstream directory were deliberately **not** used,
for reasons unrelated to code license:

- The LimeZu tileset and map assets under upstream's `src/renderer/src/assets/`
  are covered by a separate, non-transferable asset license
  (`LICENSE-ASSETS` upstream) and were never copied. Tongpin's office floor,
  desks, monitors, chairs and plants are drawn procedurally with Pixi
  `Graphics` in Tongpin's own palette instead.
- Upstream's character roster (`cast.ts`) and its per-character portrait
  recipes depict a specific, recognizable television show's cast. Neither the
  roster nor any of its recipes were copied. Tongpin's employees use
  originally-composed recipes (varied hair, skin tone and clothing) with
  generic Chinese role labels (协调员, 研究员, 分析员, 撰稿员, …) and no
  reference to the source show anywhere, including code comments.

The ported/adapted files above are covered by upstream's MIT License:

MIT License

Copyright (c) 2026 Chaitanya Giri

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
