import { describe, expect, it } from "vitest";
import { containsFileDrag, uniqueIntakeFiles } from "./attachmentIntake";
describe("shared attachment intake", () => {
  it("deduplicates the same dropped file without merging different versions", () => {
    const first = new File(["first"], "same.txt", { type: "text/plain", lastModified: 1 });
    const duplicate = new File(["first"], "same.txt", { type: "text/plain", lastModified: 1 });
    const changed = new File(["changed"], "same.txt", { type: "text/plain", lastModified: 2 });
    expect(uniqueIntakeFiles([first, duplicate, changed])).toEqual([first, changed]);
  });
  it("does not intercept text or internal non-file drags", () => {
    expect(containsFileDrag(["text/plain"])).toBe(false);
    expect(containsFileDrag(["Files", "text/uri-list"])).toBe(true);
  });
});
