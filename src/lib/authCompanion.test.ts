import { describe, expect, it } from "vitest";
import { getAuthCompanionView, isValidLoginEmail } from "./authCompanion";

const base = {
  mode: "login" as const,
  activeField: null,
  email: "",
  loading: false,
  error: "",
  notice: "",
  action: "idle" as const,
};

describe("auth companion", () => {
  it("recognizes a complete email address", () => {
    expect(isValidLoginEmail("member@example.com")).toBe(true);
    expect(isValidLoginEmail("member@localhost")).toBe(false);
  });

  it("turns away whenever the password control owns focus", () => {
    expect(
      getAuthCompanionView({ ...base, activeField: "password" }),
    ).toMatchObject({ mood: "private", privateMode: true });
  });

  it("keeps privacy mode while a login request is loading", () => {
    expect(
      getAuthCompanionView({
        ...base,
        activeField: "password",
        loading: true,
      }),
    ).toMatchObject({ mood: "loading", privateMode: true });
  });

  it("uses the real error state instead of a demo success state", () => {
    expect(
      getAuthCompanionView({ ...base, error: "密码错误" }),
    ).toMatchObject({ mood: "error", privateMode: false });
  });

  it("reacts to a valid focused email without changing authentication", () => {
    expect(
      getAuthCompanionView({
        ...base,
        activeField: "email",
        email: "member@example.com",
      }),
    ).toMatchObject({ mood: "happy", privateMode: false });
  });
});
