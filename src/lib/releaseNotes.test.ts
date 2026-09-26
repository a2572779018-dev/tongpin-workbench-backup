import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  NoticeCopy,
  normalizeNoticeItems,
  noticeSpeechText,
} from "../components/NoticeCenter";
import { releaseNoteItems, releaseNotesNotice } from "./releaseNotes";

const noticeCenterSource = readFileSync(
  new URL("../components/NoticeCenter.tsx", import.meta.url),
  "utf8",
);

describe("release notes on the in-app notice card", () => {
  it("renders several update items as a numbered list, one item per row", () => {
    const notice = releaseNotesNotice("本次更新：", "修复登录；\n新增图表；\n优化视频缓存。")!;
    const html = renderToStaticMarkup(createElement(NoticeCopy, notice));

    expect(html).toBe(
      '<p>本次更新：</p><ol class="notice-card__list"><li>修复登录</li><li>新增图表</li><li>优化视频缓存。</li></ol>',
    );
  });

  it("keeps a single item as one sentence and never renders an empty list", () => {
    expect(releaseNotesNotice("本次更新：", "修复登录；")).toEqual({ body: "本次更新：修复登录" });
    expect(releaseNotesNotice("本次更新：", "   ")).toBeNull();
    expect(releaseNotesNotice("本次更新：", undefined)).toBeNull();
    expect(renderToStaticMarkup(createElement(NoticeCopy, { body: "已准备好", items: [] }))).toBe("<p>已准备好</p>");
    expect(renderToStaticMarkup(createElement(NoticeCopy, { body: "", items: ["唯一一项"] }))).toBe("<p>唯一一项</p>");
  });

  it("splits the IPC text of the updater on line boundaries", () => {
    expect(releaseNoteItems("修复登录\n新增图表\n优化视频缓存")).toEqual(["修复登录", "新增图表", "优化视频缓存"]);
    expect(releaseNoteItems(42)).toEqual([]);
  });

  it("bounds notice items and reads them to screen readers in order", () => {
    const items = normalizeNoticeItems([" 第一项 ", "", 3, "第二项\n换行", ..."x".repeat(40).split("")])!;
    expect(items.slice(0, 2)).toEqual(["第一项", "第二项 换行"]);
    expect(items).toHaveLength(20);
    expect(normalizeNoticeItems("not-a-list")).toBeUndefined();
    expect(normalizeNoticeItems(["  "])).toBeUndefined();
    expect(noticeSpeechText({ title: "发现同频新版本", body: "版本 0.1.50 更新内容：", items: ["修复登录", "新增图表"] }))
      .toBe("发现同频新版本。版本 0.1.50 更新内容：\n1. 修复登录\n2. 新增图表");
  });

  it("feeds updater and post-install notes through the list instead of one paragraph", () => {
    expect(noticeCenterSource).toContain("releaseNotesNotice(");
    expect(noticeCenterSource).toContain("items: notes?.items");
    expect(noticeCenterSource).toContain("...releaseAnnouncementNotice(announcement)");
    expect(noticeCenterSource).not.toContain("`本次更新：${status.releaseNotes}`");
    expect(noticeCenterSource).not.toContain("：${status.releaseNotes}`");
  });
});
