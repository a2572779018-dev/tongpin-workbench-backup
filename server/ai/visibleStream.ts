import type { AiMode } from "../../shared/ai";
import { parsePublicAnalysisSummary } from "./publicExplanation";

/** Suppress protocol envelopes and private markup before they reach a client.
 * Tags can span arbitrarily many transport chunks. Only validated, complete
 * public summaries are emitted; hidden reasoning is never retained here. */
const CONTROL_TAGS = ["tool_request", "think", "reasoning_content", "analysis_summary", "/think", "/reasoning_content", "/analysis_summary"];

/** Classify text starting at "<": "tag" is a filtered control tag (keep the
 * existing wait-for-">" handling), "wait" is a still-ambiguous prefix and
 * "text" can be released immediately. Matching mirrors the \b checks below. */
function controlTagPrefix(pending: string): "tag" | "wait" | "text" {
  const rest = pending.slice(1).toLowerCase();
  let wait = false;
  for (const name of CONTROL_TAGS) {
    if (rest.length <= name.length) { if (name.startsWith(rest)) wait = true; continue; }
    if (rest.startsWith(name) && !/\w/.test(rest[name.length])) return "tag";
  }
  return wait ? "wait" : "text";
}

/** Mirrors parseAiDispatchDecision's legacy-envelope detection
 * (/^(?:```(?:json)?\s*)?\{/) on a trimmed stream prefix. */
function leadingEnvelope(pending: string): "tool" | "wait" | "answer" {
  if (pending.startsWith("{")) return "tool";
  if (!pending.startsWith("`")) return "answer";
  if (pending.length < 3) return /^`+$/.test(pending) ? "wait" : "answer";
  if (!pending.startsWith("```")) return "answer";
  const afterFence = pending.slice(3);
  if (afterFence.length < 4 && "json".startsWith(afterFence.toLowerCase())) return "wait";
  const body = /^json/i.test(afterFence) ? afterFence.slice(4) : afterFence;
  const next = body.trimStart();
  if (!next) return "wait";
  return next.startsWith("{") ? "tool" : "answer";
}

export function createVisibleStream(mode: AiMode, answer: (text: string) => void, summary: (text: string) => void) {
  let pending = "", state: "prefix" | "answer" | "private" | "summary" | "tool" = "prefix", privateTag = "", summaryText = "";
  const send = (text: string) => { if (text) answer(text); };
  return {
    feed(delta: string) {
      if (state === "tool") return;
      pending += delta;
      while (pending) {
        if (state === "prefix") {
          pending = pending.trimStart();
          // A provider may split leading whitespace into its own delta. Keep
          // waiting for the first meaningful byte so a following JSON/tool
          // envelope cannot be mistaken for public prose.
          if (!pending) return;
          // A JSON object, or the legacy ```/```json-fenced JSON envelope, is
          // buffered by the terminal parser. Other fences (```ts) and inline
          // code are ordinary prose and stream immediately.
          const lead = leadingEnvelope(pending);
          if (lead === "wait") return;
          if (lead === "tool") { state = "tool"; pending = ""; return; }
          state = "answer";
        }
        if (state === "private" || state === "summary") {
          const tag = state === "summary" ? "analysis_summary" : privateTag;
          const match = new RegExp(`<\\/${tag}\\s*>`, "i").exec(pending);
          if (!match) {
            const keep = Math.max(0, pending.lastIndexOf("<"));
            if (state === "summary" && summaryText.length < 1001) summaryText += pending.slice(0, keep);
            pending = pending.slice(keep);
            if (pending.length > 128) { if (state === "summary" && summaryText.length < 1001) summaryText += pending; pending = ""; }
            return;
          }
          if (state === "summary") {
            const value = parsePublicAnalysisSummary(summaryText + pending.slice(0, match.index), mode);
            if (value) summary(value);
            summaryText = "";
          }
          pending = pending.slice(match.index + match[0].length); state = "prefix";
          continue;
        }
        const index = pending.indexOf("<");
        if (index < 0) { send(pending); pending = ""; return; }
        send(pending.slice(0, index)); pending = pending.slice(index);
        // Only a possible control tag is held back. Ordinary "<" (a < b, <br>,
        // generics) is released at once instead of waiting for a later ">".
        const control = controlTagPrefix(pending);
        if (control === "wait") return;
        if (control === "text") {
          const next = pending.indexOf("<", 1);
          const cut = next < 0 ? pending.length : next;
          send(pending.slice(0, cut)); pending = pending.slice(cut);
          continue;
        }
        const end = pending.indexOf(">");
        if (end < 0) return;
        const tag = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        if (/^<tool_request\b/i.test(tag)) { state = "tool"; pending = ""; return; }
        if (/^<(think|reasoning_content)\b/i.test(tag)) { privateTag = /^<(\w+)/.exec(tag)![1]; state = "private"; continue; }
        if (/^<analysis_summary\b/i.test(tag)) { state = "summary"; continue; }
        if (!/^<\/(?:think|reasoning_content|analysis_summary)\b/i.test(tag)) send(tag);
      }
    },
  };
}
