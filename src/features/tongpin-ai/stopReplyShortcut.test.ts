import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPEN_MODAL_SELECTOR, shouldStopReplyOnEscape, type StopReplyEnvironment, type StopReplyKeyEvent } from "./stopReplyShortcut";

const body = { name: "body" };
const documentElement = { name: "html" };
const composer = { name: "composer", closest: () => null };
const messageButton = { name: "copy", closest: () => null };
const sidebarButton = { name: "sidebar", closest: () => null };
const mentionOption = { name: "mention", closest: (selector: string) => selector.includes('[role="listbox"]') ? {} : null };
const root = { contains: (node: unknown) => node === composer || node === messageButton || node === mentionOption };

const key = (overrides: Partial<StopReplyKeyEvent> = {}): StopReplyKeyEvent => ({
  key: "Escape", defaultPrevented: false, isComposing: false, keyCode: 27, repeat: false,
  altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target: composer, ...overrides,
});
const environment = (overrides: Partial<StopReplyEnvironment> = {}): StopReplyEnvironment => ({
  root, activeElement: composer, body, documentElement, modalOpen: false, popupOpen: false, ...overrides,
});

describe("Esc stops the running reply", () => {
  it("stops from the composer, the conversation, or an unfocused page", () => {
    expect(shouldStopReplyOnEscape(key(), environment())).toBe(true);
    expect(shouldStopReplyOnEscape(key({ target: messageButton }), environment({ activeElement: messageButton }))).toBe(true);
    expect(shouldStopReplyOnEscape(key({ target: body }), environment({ activeElement: body }))).toBe(true);
    expect(shouldStopReplyOnEscape(key({ target: documentElement }), environment({ activeElement: null }))).toBe(true);
    expect(shouldStopReplyOnEscape(key({ key: "Esc" }), environment())).toBe(true);
  });

  it("leaves Escape to the @ mention list, menus and IME composition", () => {
    // The composer's own handler closes the @ list and marks the event handled.
    expect(shouldStopReplyOnEscape(key({ defaultPrevented: true }), environment())).toBe(false);
    expect(shouldStopReplyOnEscape(key(), environment({ popupOpen: true }))).toBe(false);
    expect(shouldStopReplyOnEscape(key({ target: mentionOption }), environment({ activeElement: mentionOption }))).toBe(false);
    expect(shouldStopReplyOnEscape(key({ isComposing: true }), environment())).toBe(false);
    expect(shouldStopReplyOnEscape(key({ keyCode: 229 }), environment())).toBe(false);
  });

  it("never fires behind a dialog, outside the chat, for repeats, modifiers or other keys", () => {
    expect(shouldStopReplyOnEscape(key(), environment({ modalOpen: true }))).toBe(false);
    expect(shouldStopReplyOnEscape(key({ target: sidebarButton }), environment({ activeElement: sidebarButton }))).toBe(false);
    expect(shouldStopReplyOnEscape(key({ repeat: true }), environment())).toBe(false);
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) expect(shouldStopReplyOnEscape(key({ [modifier]: true }), environment())).toBe(false);
    expect(shouldStopReplyOnEscape(key({ key: "Enter" }), environment())).toBe(false);
  });

  it("treats any open modal dialog on the page as owning Escape", () => {
    expect(OPEN_MODAL_SELECTOR).toContain('[aria-modal="true"]');
    expect(OPEN_MODAL_SELECTOR).toContain("dialog[open]");
  });

  it("is wired to the existing stop action only while a reply runs", () => {
    const workspace = readFileSync(new URL("./ChatWorkspace.tsx", import.meta.url), "utf8");
    expect(workspace).toContain("const canStopWithEscape = responding && Boolean(onStop) && !computerRequest;");
    const effect = workspace.slice(workspace.indexOf("useEffect(() => {\n    if (!canStopWithEscape) return;"), workspace.indexOf("}, [canStopWithEscape]);"));
    expect(effect).toContain('document.addEventListener("keydown", stopOnEscape)');
    expect(effect).toContain('document.removeEventListener("keydown", stopOnEscape)');
    expect(effect).toContain("popupOpen: composerPopupRef.current");
    expect(effect).toContain("stopRef.current?.();");
    expect(workspace).toContain("composerPopupRef.current = Boolean(mention) || Boolean(menu);");
    // The @ mention handler still consumes its own Escape first.
    expect(workspace).toContain('if (event.key === "Escape") { event.preventDefault(); setMention(undefined); return; }');
    const page = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");
    expect(page).toContain("onStop={stopResponse}");
  });
});
