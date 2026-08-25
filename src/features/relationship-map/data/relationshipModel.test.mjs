import { describe, expect, it } from "vitest";
import {
  buildConnectionRecord,
  connectionsForPerson,
  validateConnectionDraft,
} from "./relationshipModel.js";

const people = [
  { id: "self", name: "本人" },
  { id: "a", name: "人物甲" },
  { id: "b", name: "人物乙" },
];

describe("relationship editing model", () => {
  it("builds a new relationship with normalized text and strength", () => {
    const draft = {
      source: "a",
      target: "b",
      relationship: "  导师  ",
      strength: 0.82,
      note: "  项目期间结识  ",
    };
    expect(validateConnectionDraft(draft, people, [])).toEqual({});
    expect(buildConnectionRecord(draft)).toEqual({
      source: "a",
      target: "b",
      relationship: "导师",
      strength: 0.82,
      note: "项目期间结识",
    });
  });

  it("rejects reversed duplicates and lists editable related records", () => {
    const connections = [
      { source: "a", target: "b", relationship: "朋友" },
    ];
    expect(
      validateConnectionDraft(
        { source: "b", target: "a", relationship: "同事" },
        people,
        connections,
      ).target,
    ).toMatch(/已有关系/);
    expect(connectionsForPerson(connections, "a")[0].index).toBe(0);
  });
});
