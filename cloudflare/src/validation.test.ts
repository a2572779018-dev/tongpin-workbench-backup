import { describe, expect, it } from "vitest";
import { parseTaskCreate } from "./validation";

const baseTask = {
  title: "整理日报",
  details: "",
  date: "2026-08-11",
  priority: "p2",
};

describe("Cloudflare task creation scope validation", () => {
  it("defaults old clients to the selected day", () => {
    expect(parseTaskCreate(baseTask)).toMatchObject({
      scope: "day",
      status: "todo",
    });
  });

  it("accepts creation through the rest of the week", () => {
    expect(
      parseTaskCreate({ ...baseTask, scope: "rest_of_week" }).scope,
    ).toBe("rest_of_week");
  });

  it("rejects unknown creation scopes", () => {
    expect(() => parseTaskCreate({ ...baseTask, scope: "month" })).toThrow(
      "任务创建范围不正确",
    );
  });
});
