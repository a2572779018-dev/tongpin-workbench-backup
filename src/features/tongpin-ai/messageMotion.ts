import { prefersReducedMotion } from "./motion";

/**
 * Entrance motion for the chat log without animating the log itself (no
 * auto-animate observers on the message list, see motion.test.ts): after each
 * render ChatWorkspace compares the message ids with the previous render and
 * eases in only rows that were appended live — the member's sent message, the
 * reply placeholder, a computer-use result — or fades the whole log once when
 * another conversation opens. History that loads above, a conversation that
 * hydrates in bulk and rows that replace other rows stay still.
 */

export interface MotionMessage {
  id: string;
  role: string;
  status?: string;
  content: string;
  startedAt?: number;
}

export interface MessageMotionBaseline {
  conversationId: string | null | undefined;
  ids: readonly string[];
}

export type RowEntrance = "user" | "assistant";

export interface MessageMotionPlan {
  /** Fade the whole log in (another conversation opened). */
  list: boolean;
  rows: Array<{ id: string; entrance: RowEntrance }>;
}

const NO_MOTION: MessageMotionPlan = { list: false, rows: [] };
/** More rows than a send adds at once (user + reply + a result) is a bulk load, not a live append. */
export const MAX_LIVE_ROWS = 3;

function waitingReply(message: MotionMessage): boolean {
  return message.role === "assistant" && (message.status === "thinking" || !message.content);
}

function entrance(message: MotionMessage): RowEntrance | null {
  if (message.role === "user") return "user";
  return message.role === "assistant" ? "assistant" : null;
}

/** A waiting reply this recent was just sent, not found running in the background. */
export const FRESH_SEND_MS = 5_000;

/**
 * A conversation that appears with nothing before it (the welcome screen, or
 * a list that just loaded) holding only a send made right now: the member's
 * message alone, or with a reply placeholder that just started.
 */
function freshSend(messages: readonly MotionMessage[], now: number): boolean {
  const last = messages.at(-1);
  if (!last || messages.length > MAX_LIVE_ROWS) return false;
  if (last.role === "user") return messages.length === 1;
  return waitingReply(last) && (last.startedAt === undefined || (now - last.startedAt >= 0 && now - last.startedAt <= FRESH_SEND_MS));
}

/** What eases in after this render; `previous` is the last render's baseline (null on mount). */
export function planMessageMotion(previous: MessageMotionBaseline | null, conversationId: string | null | undefined, messages: readonly MotionMessage[], now: number = Date.now()): MessageMotionPlan {
  if (!previous) return NO_MOTION;
  // Another conversation opened, or this one's list just loaded (V2 mounts it
  // empty): fade the log in once, unless it holds only a send made right now
  // (the first send from the welcome screen), whose rows ease in instead.
  if (previous.conversationId !== conversationId || (!previous.ids.length && messages.length > 0)) {
    const fromNothing = previous.conversationId == null || !previous.ids.length;
    if (!fromNothing || !freshSend(messages, now)) return messages.length || previous.ids.length ? { list: true, rows: [] } : NO_MOTION;
    return { list: false, rows: messages.flatMap(message => { const kind = entrance(message); return kind ? [{ id: message.id, entrance: kind }] : []; }) };
  }
  const known = new Set(previous.ids);
  const current = new Set(messages.map(message => message.id));
  // Rows that replaced others (a streamed placeholder swapped for the saved
  // reply, a reconciled history) are not new content.
  if (previous.ids.some(id => !current.has(id))) return NO_MOTION;
  let start = messages.length;
  while (start > 0 && !known.has(messages[start - 1].id)) start -= 1;
  const appended = messages.slice(start);
  if (!appended.length || appended.length > MAX_LIVE_ROWS) return NO_MOTION;
  return { list: false, rows: appended.flatMap(message => { const kind = entrance(message); return kind ? [{ id: message.id, entrance: kind }] : []; }) };
}

export const MESSAGE_MOTION_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const ROW_KEYFRAMES: Record<RowEntrance, Keyframe[]> = {
  // The sent bubble rises out of the composer area.
  user: [{ opacity: 0, transform: "translateY(14px) scale(0.97)" }, { opacity: 1, transform: "none" }],
  assistant: [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
};
const ROW_TIMING: Record<RowEntrance, KeyframeAnimationOptions> = {
  user: { duration: 240, easing: MESSAGE_MOTION_EASING },
  // The reply follows the member's message instead of arriving with it.
  assistant: { duration: 240, delay: 90, easing: MESSAGE_MOTION_EASING, fill: "backwards" },
};
const LIST_KEYFRAMES: Keyframe[] = [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }];
const LIST_TIMING: KeyframeAnimationOptions = { duration: 200, easing: MESSAGE_MOTION_EASING };

function rowElement(list: HTMLElement, id: string): HTMLElement | null {
  for (const element of list.querySelectorAll<HTMLElement>("[data-ai-message-id]")) if (element.dataset.aiMessageId === id) return element;
  return null;
}

/** Runs the plan with the Web Animations API (nothing to clean up, no layout
 * change). Under prefers-reduced-motion nothing moves. */
export function playMessageMotion(list: HTMLElement, plan: MessageMotionPlan, reduced: () => boolean = prefersReducedMotion): void {
  if ((!plan.list && !plan.rows.length) || typeof list.animate !== "function" || reduced()) return;
  if (plan.list) list.animate(LIST_KEYFRAMES, LIST_TIMING);
  for (const row of plan.rows) rowElement(list, row.id)?.animate(ROW_KEYFRAMES[row.entrance], ROW_TIMING[row.entrance]);
}
