import { describe, expect, it } from "vitest";
import {
  CUSTOMER_COOPERATION_STATUS,
  customerCooperationStatusLabel,
  customerIdForEdge,
  normalizeCustomerCooperationStatus,
} from "./customerStatus.js";

describe("customer cooperation status", () => {
  it("keeps pending explicit and migrates missing or unknown values to collaborated", () => {
    expect(normalizeCustomerCooperationStatus("pending")).toBe(CUSTOMER_COOPERATION_STATUS.PENDING);
    expect(normalizeCustomerCooperationStatus("collaborated")).toBe(CUSTOMER_COOPERATION_STATUS.COLLABORATED);
    expect(normalizeCustomerCooperationStatus(undefined)).toBe(CUSTOMER_COOPERATION_STATUS.COLLABORATED);
    expect(normalizeCustomerCooperationStatus("unknown")).toBe(CUSTOMER_COOPERATION_STATUS.COLLABORATED);
  });

  it("uses the deeper endpoint as the customer controlled by a line", () => {
    const depthById = new Map([["self", 0], ["a", 1], ["a1", 2]]);
    expect(customerIdForEdge("self", "a", depthById)).toBe("a");
    expect(customerIdForEdge("a1", "a", depthById)).toBe("a1");
  });

  it("returns the exact legend labels", () => {
    expect(customerCooperationStatusLabel("collaborated")).toBe("已合作客户");
    expect(customerCooperationStatusLabel("pending")).toBe("待合作客户");
  });
});
