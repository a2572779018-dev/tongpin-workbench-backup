import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("AI native cursor boundary", () => {
  it("unmounts the main-thread cursor for both AI routes, preserving it elsewhere", () => {
    const app = read("../App.tsx");
    expect(app.match(/<CustomCursor\s*\/>/g)).toHaveLength(1);
    expect(app).toContain('{view !== "ai" && view !== "admin-ai" && <CustomCursor />}');
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
