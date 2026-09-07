import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminAiMemberIdentity } from "./AdminAiQuotaPanel";

describe("AI quota member identity", () => {
  it("identifies the boss next to the account name without replacing the email", () => {
    const markup = renderToStaticMarkup(createElement(AdminAiMemberIdentity, {
      member: { name: "测试老板", email: "boss@example.test", role: "boss" },
    }));
    expect(markup).toContain('<strong>测试老板</strong>');
    expect(markup).toContain('class="tp-ai-admin-member-role">老板</span>');
    expect(markup).toContain('<small>boss@example.test</small>');
  });

  it.each(["member", "admin", "unknown"])("does not mislabel a %s account as a boss", role => {
    const markup = renderToStaticMarkup(createElement(AdminAiMemberIdentity, {
      member: { name: "测试账号", email: "member@example.test", role },
    }));
    expect(markup).not.toContain('tp-ai-admin-member-role');
    expect(markup).toContain("测试账号");
  });
});
