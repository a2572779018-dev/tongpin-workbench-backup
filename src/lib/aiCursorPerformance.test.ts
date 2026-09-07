import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("AI directional cursor boundary", () => {
  it("keeps a native fallback and text entry affordances alongside the rotating cursor", () => {
    const styles = read("../styles.css");
    expect(styles).toContain('cursor: url("./assets/tongpin-cursor.svg") 10 2, auto !important;');
    expect(styles).toContain('html[data-app-view="ai"]:where(:not(.custom-cursor-enabled)) *');
    expect(styles).toMatch(/html\[data-app-view="ai"\] textarea,/);
    expect(styles).toContain("cursor: text !important;");
    expect(read("../assets/tongpin-cursor.svg")).toContain('width="20" height="20"');
    expect(read("../features/tongpin-ai/visuals/TongpinAICharacter.tsx")).toContain("followPointer interactive={false}");
  });
  it("mounts exactly one event-driven directional cursor, including AI routes", () => {
    const app = read("../App.tsx");
    expect(app.match(/<CustomCursor\s*\/>/g)).toHaveLength(1);
    expect(app).not.toContain('view !== "ai" && view !== "admin-ai" && <CustomCursor');
    const cursor = read("../components/CustomCursor.tsx");
    expect(cursor).toContain("const FRAME_INTERVAL = 1000 / 60;");
    expect(cursor).toContain("if (!frame) frame = window.requestAnimationFrame(paint);");
    expect(cursor).toContain("if (!finePointer.matches || document.hidden || suppressed) return;");
    expect(cursor).toContain("if (suppressed) { hide(); return; }");
    expect(cursor).not.toContain("getBoundingClientRect");
    expect(cursor).not.toContain("useState");
  });

  it("cancels pending paint on blur and leave so a stale frame cannot resurrect the cursor", () => {
    const cursor = read("../components/CustomCursor.tsx");
    const hide = cursor.slice(cursor.indexOf("const hide = () => {"), cursor.indexOf("const paint ="));
    expect(hide).toContain("window.cancelAnimationFrame(frame)");
    expect(hide).toContain("frame = 0;");
    expect(hide).toContain('root.classList.remove("custom-cursor-enabled")');
  });

  it("removes the cursor:none selector's enabling class and pending animation on unmount", () => {
    const cursor = read("../components/CustomCursor.tsx");
    const cleanup = cursor.slice(cursor.indexOf("return () => {"), cursor.indexOf("  }, []);"));
    // Hiding only the custom arrow would leave the system pointer invisible.
    // Component cleanup must remove its global CSS gate and animation listener.
    expect(cleanup).toContain("window.cancelAnimationFrame(frame)");
    expect(cleanup).toContain('window.removeEventListener("pointermove", handlePointerMove)');
    expect(cleanup).toMatch(/root\.classList\.remove\(\s*"custom-cursor-enabled",\s*"custom-cursor-reduced-motion",?\s*\)/);
    const styles = read("../styles.css");
    expect(styles).toMatch(/html\.custom-cursor-enabled \*\s*\{\s*cursor:\s*none\s*!important;/);
  });
});
