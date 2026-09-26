# Third-party notices

## OpenSquilla SquillaRouter V4.2 (desktop quick-tier router)

The Tongpin desktop app runs OpenSquilla's SquillaRouter V4.2 Phase 3 local
turn router to classify quick-tier chat turns into OpenSquilla's C0–C3 tiers;
the server maps each tier to a behaviour the administrator allows for the quick
tier.

- Upstream project: https://github.com/TokenRhythm/opensquilla (OpenSquilla
  0.5.5, commit d27ba0e7ac452392b7c8e38f2f7f43cd5d6912c6), by the OpenSquilla
  contributors.
- License: Apache License 2.0 (full text below). The upstream repository has no
  `NOTICE` file; the attribution its `THIRD_PARTY_NOTICES.md` records for the
  router bundle's BGE assets is reproduced in the next section.
- Redistributed in the desktop app only (`electron/opensquilla-router/bundle/`,
  unpacked from ASAR): the router bundle
  `src/opensquilla/squilla_router/models/v4.2_phase3_inference/`. `bge.onnx`
  (the INT8 BGE ONNX export), `mlp.onnx` and `tokenizer.json` are byte-identical
  copies. The TF-IDF vocabulary and idf, TruncatedSVD components, BGE PCA, MLP
  scaler and both LightGBM heads were converted by
  `scripts/opensquilla-router/convert_bundle.py` from the upstream
  pickle/joblib/LightGBM model files into JSON and little-endian arrays with
  round-trip checks; `router.runtime.yaml` and the gateway routing-policy
  defaults are recorded in `manifest.json` with every upstream sha256. Only the
  storage format changed, not the fitted values. The desktop app never unpickles
  model files.
- Modified files (Apache-2.0 section 4(b)): the router's inference logic
  (feature extraction, head fusion, post-processing, the gateway routing policy
  and per-conversation routing history) was ported from OpenSquilla's Python
  sources to TypeScript in `src/features/tongpin-ai/opensquilla/` and adapted to
  run in an Electron worker thread with ONNX Runtime Web; each derived file says
  so in its header. OpenSquilla's gateway, telemetry and other components are not
  included. The web build does not contain the router.
- The name "OpenSquilla" is used only to identify where the router comes from;
  Tongpin is not affiliated with or endorsed by the OpenSquilla project.

Without a desktop decision (web build, older clients, router not ready) the
quick tier keeps Tongpin's own built-in routing in `server/ai/autoRouting.ts`.

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## BAAI bge-small-zh-v1.5 (OpenSquilla router embedding model)

- Component: the ONNX export and tokenizer files derived from
  BAAI/bge-small-zh-v1.5 that ship unchanged inside the OpenSquilla router
  bundle (`electron/opensquilla-router/bundle/bge.onnx`, `tokenizer.json`).
- Upstream model: https://huggingface.co/BAAI/bge-small-zh-v1.5
- Upstream project: https://github.com/FlagOpen/FlagEmbedding
- License: MIT, as recorded in OpenSquilla's `THIRD_PARTY_NOTICES.md`; the
  upstream model card states the released models can be used for commercial
  purposes free of charge.

MIT License

Copyright (c) 2022 staoxiao

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

## ONNX Runtime Web

- Components: `onnxruntime-web` 1.30.0 and `onnxruntime-common` 1.30.0
  (https://github.com/microsoft/onnxruntime). Their JavaScript is bundled into
  the desktop app's `electron/opensquilla-router/runtime/router-worker.cjs`, and
  `ort-wasm-simd-threaded.mjs` / `ort-wasm-simd-threaded.wasm` are copied
  unchanged next to it. The web build does not include them.
- License: MIT, Copyright (c) Microsoft Corporation.
- The WebAssembly binary is a build of ONNX Runtime together with the
  third-party libraries it compiles in. Their notices ship with the desktop app
  in `electron/opensquilla-router/licenses/onnxruntime-ThirdPartyNotices.txt`,
  an unmodified copy of
  https://github.com/microsoft/onnxruntime/blob/v1.30.0/ThirdPartyNotices.txt
  (sha256 143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3).

MIT License

Copyright (c) Microsoft Corporation

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
