import type { AiCitation, AiSource } from "./ai";

/** Hard caps shared by the server producer, workspace validation and the renderer. */
export const AI_CITATION_LIMITS = {
  /** Positioned provider citations kept per reply. */
  citations: 64,
  /** Web-search sources listed per reply; a cited page may extend the ordinary 30. */
  sources: 40,
} as const;

const TRACKING_PARAM = /^(utm_[a-z]+|spm|from|ref|ref_src|fbclid|gclid)$/i;

/** Same page = same scheme-less host + path + meaningful query. Fragments and
 * tracking parameters never make a citation a different source. */
export function sourceIdentity(raw: string): string {
  try {
    const url = new URL(raw);
    const query = [...url.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAM.test(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`).join("&");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.hostname.replace(/^www\./, "").toLowerCase()}${pathname}${query ? `?${query}` : ""}`;
  } catch {
    return raw.trim();
  }
}

/** 1-based source numbers in first-appearance order after sourceIdentity
 * dedupe: exactly the order in which a reply's source list is rendered. */
export function aiSourceNumbers(sources: readonly AiSource[] | undefined): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const source of sources ?? []) {
    if (!source || typeof source.url !== "string" || !source.url.trim()) continue;
    const key = sourceIdentity(source.url);
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
  }
  return numbers;
}

function splitsSurrogatePair(content: string, offset: number): boolean {
  const before = content.charCodeAt(offset - 1), after = content.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Structural check for one persisted citation: exact fields, integer bounds,
 * an existing source and a UTF-16 marker offset inside `content`. */
export function isAiCitation(value: unknown, content: string, sourceCount: number): value is AiCitation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.length !== 3 || !keys.every(key => key === "n" || key === "sourceIndex" || key === "end")) return false;
  const { n, sourceIndex, end } = item;
  return Number.isSafeInteger(n) && Number(n) >= 1 && Number(n) <= sourceCount
    && Number.isSafeInteger(sourceIndex) && Number(sourceIndex) >= 0 && Number(sourceIndex) < sourceCount
    && Number.isSafeInteger(end) && Number(end) >= 1 && Number(end) <= content.length
    && !splitsSurrogatePair(content, Number(end));
}
