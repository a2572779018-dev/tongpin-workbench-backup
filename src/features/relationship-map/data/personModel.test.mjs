import { describe, expect, it } from "vitest";
import { buildPersonRecord, validatePersonDraft } from "./personModel.js";

const baseDraft = {
  name: "新客户",
  alias: "采购负责人",
  relationship: "已合作客户",
  level: "close",
  community: "客户",
  cooperationStatus: "pending",
  phone: "",
  wechat: "",
  tags: "",
  note: "",
  avatar: null,
};

describe("customer cooperation status in person records", () => {
  it("stores the selected status on a new customer", () => {
    expect(buildPersonRecord(baseDraft, []).cooperationStatus).toBe("pending");
  });

  it("rejects an unsupported status instead of silently saving it", () => {
    expect(validatePersonDraft({ ...baseDraft, cooperationStatus: "unknown" })).toMatchObject({
      cooperationStatus: "请选择有效的合作状态",
    });
  });
});
