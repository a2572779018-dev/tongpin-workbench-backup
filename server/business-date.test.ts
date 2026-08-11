import { describe, expect, it } from "vitest";
import { taskDatesForScope } from "./business-date";

describe("task creation date scope", () => {
  it("keeps the default day scope on the selected date", () => {
    expect(taskDatesForScope("2026-08-11", "day")).toEqual([
      "2026-08-11",
    ]);
  });

  it("creates every calendar day from Monday through Sunday", () => {
    expect(taskDatesForScope("2026-08-10", "rest_of_week")).toEqual([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
    ]);
  });

  it("creates only Sunday when the selected date is Sunday", () => {
    expect(taskDatesForScope("2026-08-16", "rest_of_week")).toEqual([
      "2026-08-16",
    ]);
  });

  it("continues correctly across month and year boundaries", () => {
    expect(taskDatesForScope("2026-08-31", "rest_of_week")).toEqual([
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
    ]);
    expect(taskDatesForScope("2026-12-31", "rest_of_week")).toEqual([
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
    ]);
  });
});
