import { describe, expect, it } from "vitest";
import { buildPersonRecord, validatePersonDraft } from "./personModel.js";

const baseDraft = {
  name: "新客户",
  alias: "采购负责人",
  relationship: "已合作客户",
  level: "close",
  community: "客户",
  cooperationStatus: "pending",
  gender: "女",
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

describe("customer identity color in person records", () => {
  it("stores a selected identity color independently from relationship level", () => {
    const person = buildPersonRecord({ ...baseDraft, level: "acquaintance", colorKey: "yellow" }, []);
    expect(person.level).toBe("acquaintance");
    expect(person.colorKey).toBe("yellow");
  });

  it("preserves an existing identity color when an older editor omits the field", () => {
    const editingPerson = {
      ...buildPersonRecord({ ...baseDraft, colorKey: "green" }, []),
      id: "existing-customer",
    };
    const edited = buildPersonRecord(
      { ...baseDraft, name: "更新后的客户", colorKey: undefined },
      [editingPerson],
      editingPerson,
    );

    expect(edited.colorKey).toBe("green");
  });

  it("rejects unsupported identity color keys", () => {
    expect(validatePersonDraft({ ...baseDraft, colorKey: "purple" })).toMatchObject({
      colorKey: "请选择有效的身份颜色",
    });
  });
});

describe("customer gender in person records", () => {
  it.each(["男", "女"])("stores the supported %s value", (gender) => {
    expect(buildPersonRecord({ ...baseDraft, gender }, []).gender).toBe(gender);
  });

  it("rejects values outside the fixed two-option list", () => {
    expect(validatePersonDraft({ ...baseDraft, gender: "未知" })).toMatchObject({
      gender: "性别只能选择男或女",
    });
  });

  it("keeps legacy records without gender readable", () => {
    const { gender: _gender, ...legacyDraft } = baseDraft;
    expect(buildPersonRecord(legacyDraft, []).gender).toBe("");
  });
});
