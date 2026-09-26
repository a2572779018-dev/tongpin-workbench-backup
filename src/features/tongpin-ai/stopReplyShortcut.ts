/**
 * Esc stops the reply that is currently running in this conversation, using
 * the same action as the composer's stop button. It never competes with an
 * Escape that already means something else: IME composition, the @ mention
 * list, the attachment/tool menus, open dialogs, or focus outside the chat.
 * It also stays inert while the composer holds text: a member typing a
 * correction for the running task must never stop that task with Esc.
 * The modal/menu guards follow LibreChat v0.8.7 (MIT)
 * `client/src/hooks/useKeyboardShortcuts.ts` (`anyModalOpen`,
 * `isWithinOpenMenu`); the key binding itself is Tongpin's.
 */
export interface StopReplyKeyEvent {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: unknown;
}

export interface StopReplyEnvironment {
  /** The chat surface: header, message log and composer. */
  root: { contains(node: unknown): boolean } | null;
  activeElement: unknown;
  body: unknown;
  documentElement: unknown;
  /** Any open modal dialog on the page (see OPEN_MODAL_SELECTOR). */
  modalOpen: boolean;
  /** A popup owned by the composer, such as the @ mention list or a menu. */
  popupOpen: boolean;
  /** The composer holds a typed supplement/correction: Esc must not kill the task. */
  composerHasText?: boolean;
}

export const OPEN_MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"], dialog[open]';
const POPUP_SELECTOR = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], dialog';

function withinPopup(target: unknown): boolean {
  const candidate = target as { closest?: (selector: string) => unknown } | null;
  return Boolean(candidate && typeof candidate.closest === "function" && candidate.closest(POPUP_SELECTOR));
}

export function shouldStopReplyOnEscape(event: StopReplyKeyEvent, environment: StopReplyEnvironment): boolean {
  if (event.key !== "Escape" && event.key !== "Esc") return false;
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (environment.modalOpen || environment.popupOpen || environment.composerHasText || withinPopup(event.target)) return false;
  const focus = environment.activeElement;
  const pageFocused = !focus || focus === environment.body || focus === environment.documentElement;
  return pageFocused || Boolean(environment.root?.contains(focus));
}
