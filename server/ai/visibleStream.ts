import type { AiMode } from "../../shared/ai";
import { parsePublicAnalysisSummary } from "./publicExplanation";

/** Suppress protocol envelopes and private markup before they reach a client.
 * Tags can span arbitrarily many transport chunks. Only validated, complete
 * public summaries are emitted; hidden reasoning is never retained here. */
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
          // JSON and code fences are buffered by the terminal parser. A plain
          // answer starting with a code block still works, without live deltas.
          if (pending.startsWith("{") || pending.startsWith("`")) { state = "tool"; pending = ""; return; }
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
