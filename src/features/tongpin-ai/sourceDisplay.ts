import type { AiSource } from "../../../shared/ai";

/** How many citations stay visible before the rest fold behind a toggle. */
export const VISIBLE_SOURCE_COUNT = 5;

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

/** A readable label: a real page title, or host + short path when the
 * provider only returned the bare domain as the "title". */
export function sourceLabel(source: AiSource): string {
  const title = source.title?.trim() ?? "";
  let url: URL | null = null;
  try { url = new URL(source.url); } catch { url = null; }
  if (!url) return title || source.url;
  const host = url.hostname.replace(/^www\./, "");
  const titleIsHost = !title || title.replace(/^www\./, "").toLowerCase() === host.toLowerCase() || title === source.url;
  if (!titleIsHost) return title;
  const segments = url.pathname.split("/").filter(Boolean);
  if (!segments.length) return host;
  let tail = segments.slice(-2).join("/");
  try { tail = decodeURIComponent(tail); } catch { /* keep encoded */ }
  if (tail.length > 48) tail = `…${tail.slice(-47)}`;
  return `${host} · ${tail}`;
}

/** Drop repeated citations (first occurrence wins, keeping its title when a
 * later duplicate has none) and split into always-visible and folded parts. */
export function displaySources(sources: readonly AiSource[] | undefined): { visible: AiSource[]; folded: AiSource[] } {
  const unique = new Map<string, AiSource>();
  for (const source of sources ?? []) {
    if (!source || typeof source.url !== "string" || !source.url.trim()) continue;
    const key = sourceIdentity(source.url);
    const existing = unique.get(key);
    if (!existing) unique.set(key, source);
    else if (!existing.title?.trim() && source.title?.trim()) unique.set(key, { ...existing, title: source.title });
  }
  const list = [...unique.values()];
  return { visible: list.slice(0, VISIBLE_SOURCE_COUNT), folded: list.slice(VISIBLE_SOURCE_COUNT) };
}
