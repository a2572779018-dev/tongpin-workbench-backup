/** Real React components in isolated headless Chrome; synthetic transport only.
 * Start Vite on 127.0.0.1:5181, then set TONGPIN_PLAYWRIGHT_MODULE if Playwright
 * is supplied outside this repository. No real account or provider is used. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const { chromium } = await import(process.env.TONGPIN_PLAYWRIGHT_MODULE ?? "playwright");

const base = "http://127.0.0.1:5181/scripts/ai-conversation-acceptance.html";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = {};
async function fixture(suffix = "") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}?run=${crypto.randomUUID()}${suffix}`);
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  return { page, context, errors };
}
const row = (page, title) => page.locator(`.tp-ai-conversation-row__select[title="${title}"]`);
const evidence = page => page.locator('output[aria-label="验收证据"]');
async function openActions(page) {
  const button = page.getByRole("button", { name: "添加附件或生成内容" });
  if (await button.getAttribute("aria-expanded") !== "true") await button.click();
}
try {
  {
    const { page, context, errors } = await fixture("&fast");
    for (let index = 0; index < 24; index++) {
      await page.locator("textarea").fill(`隔离延迟样本 ${index + 1}`);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await page.waitForFunction(expected => (document.querySelector('output[aria-label="验收证据"]')?.textContent?.match(/stream:finished/g)?.length ?? 0) >= expected, index + 1);
      await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    }
    const samples = [...(await evidence(page).innerText()).matchAll(/visible_feedback_ms=([\d.]+)/g)].map(match => Number(match[1]));
    assert.equal(samples.length, 24);
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(samples.length * 0.95) - 1];
    assert.ok(p95 <= 200, `feedback p95 ${p95} ms exceeds 200 ms`);
    assert.deepEqual(errors, []);
    results.feedback = { samples: samples.length, p95Ms: p95, maxMs: Math.max(...samples), allMs: samples };
    await context.close();
  }
  {
    const { page, context, errors } = await fixture();
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await row(page, "B 编辑中").click();
    assert.equal(await page.locator("textarea").inputValue(), "B 的草稿不能丢");
    assert.ok(await page.getByRole("button", { name: "移除附件 B.txt" }).isVisible());
    assert.equal(await row(page, "C 后台视频").locator('[aria-label="任务进行中"]').count(), 1);
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("DOM:first-delta-visible-before-finish"));
    assert.ok(!(await evidence(page).innerText()).includes("stream:finished"));
    await page.waitForFunction(() => document.querySelector('button[title="A 异步任务"] [aria-label="有未读完成结果"]'));
    assert.equal(await row(page, "B 编辑中").getAttribute("aria-current"), "page");
    await page.waitForFunction(() => document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("stream:finished"));
    await page.locator("textarea").fill("B 后续草稿保持原样");
    await page.waitForFunction(() => document.querySelector('button[title="C 后台视频"] [aria-label="有未读完成结果"]'), null, { timeout: 20000 });
    assert.equal(await page.locator("textarea").inputValue(), "B 后续草稿保持原样");
    const events = await evidence(page).innerText();
    assert.equal((events.match(/media-task-post:image:a:refs=0/g) ?? []).length, 1);
    assert.ok(events.includes("project-context:A immutable project instructions"));
    assert.ok(events.includes("attachments=B.txt"));
    await page.screenshot({ path: "/tmp/tongpin-conversation-concurrent.png" });
    await page.waitForTimeout(1600); // allow the workspace debounce to save B's new draft
    await page.reload();
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    assert.equal(await row(page, "B 编辑中").getAttribute("aria-current"), "page");
    assert.equal(await page.locator("textarea").inputValue(), "B 后续草稿保持原样");
    assert.equal(await row(page, "A 异步任务").locator('[aria-label="有未读完成结果"]').count(), 1);
    assert.equal(await row(page, "C 后台视频").locator('[aria-label="有未读完成结果"]').count(), 1);
    await row(page, "A 异步任务").click();
    await page.waitForFunction(() => !document.querySelector('button[title="A 异步任务"] [aria-label="有未读完成结果"]'));
    await row(page, "B 编辑中").click();
    await page.reload();
    await row(page, "A 异步任务").waitFor();
    assert.equal(await row(page, "A 异步任务").locator('[aria-label="有未读完成结果"]').count(), 0);
    assert.equal(await row(page, "C 后台视频").locator('[aria-label="有未读完成结果"]').count(), 1);
    assert.deepEqual(errors, []);
    results.concurrent = { threeConversations: true, backgroundVideo: true, firstDeltaBeforeFinish: true, aCompletionKeptBFocus: true, bAttachmentIsolated: true, unseenSurvivesReload: true, seenSurvivesReload: true };
    await context.close();
  }
  {
    const { page, context, errors } = await fixture();
    const sourceBytes = readFileSync(fileURLToPath(new URL("./video-chat-fixture.mp4", import.meta.url))).toString("base64");
    const transfer = await page.evaluateHandle(base64 => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const value = new DataTransfer();
      value.items.add(new File([bytes], "video-chat-fixture.mp4", { type: "video/mp4" }));
      return value;
    }, sourceBytes);
    await page.evaluate(value => {
      const target = document.querySelector("section.tp-ai-chat");
      target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: value }));
    }, transfer);
    await page.locator(".tp-ai-file-drop-overlay").waitFor();
    await page.evaluate(value => {
      const target = document.querySelector("section.tp-ai-chat");
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: value }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: value }));
    }, transfer);
    await transfer.dispose();
    await page.locator(".tp-ai-video-frame-picker button").first().waitFor();
    const frames = page.locator(".tp-ai-video-frame-picker button");
    assert.ok(await frames.count() >= 2);
    assert.equal(await page.locator('.tp-ai-video-frame-picker button[aria-pressed="true"]').count(), 0);
    await page.locator("textarea").fill("@video 用这个角色做一个短视频");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    assert.ok((await page.locator("body").innerText()).includes("请先在视频附件中选择一个采样画面"));
    assert.ok(!(await evidence(page).innerText()).includes("video-reference:"));
    await frames.nth(1).click();
    assert.equal(await page.locator(".tp-ai-toast").count(), 0, "selecting a frame must dismiss the stale selection warning");
    const selectedLabel = await frames.nth(1).getAttribute("aria-label");
    await page.setViewportSize({ width: 720, height: 1000 });
    await page.getByRole("button", { name: "收起侧边栏" }).click();
    assert.equal(await frames.nth(1).isVisible(), true);
    assert.equal(await page.locator('.tp-ai-video-frame-picker button[aria-pressed="true"]').count(), 1);
    await page.screenshot({ path: "/tmp/tongpin-video-frame-selection.png" });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("media-task-post:video:a:refs=1"), null, { timeout: 15000 });
    const events = await evidence(page).innerText();
    assert.equal((events.match(/video-reference:/g) ?? []).length, 1);
    assert.equal((events.match(/media-task-post:video:a:refs=1/g) ?? []).length, 1);
    assert.ok(events.includes('"conversationId":"a"'));
    assert.ok(events.includes('"name":"video-chat-fixture.mp4"'));
    await page.locator('.tp-ai-media-task-reply video').waitFor({ timeout: 15000 });
    assert.deepEqual(errors, []);
    results.videoFrame = { decodedRealLocalVideo: true, fileDroppedOnConversation: true, noDefaultSelection: true, selectedLabel, durableSelectedSourceBeforeUpload: true, referenceUploads: 1, mediaTaskSubmissions: 1, completedVideoPlayable: true, narrowViewportChecked: true };
    await context.close();
  }
  {
    const { page, context, errors } = await fixture("&imageEdit");
    await openActions(page);
    assert.equal(await page.getByRole("menuitem", { name: "上传图片" }).isDisabled(), true);
    await page.getByLabel("思考模式").selectOption("quick");
    await openActions(page);
    await page.getByRole("menuitem", { name: "生成图片" }).click();
    await openActions(page);
    assert.equal(await page.getByRole("menuitem", { name: "上传图片" }).isDisabled(), true);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "取消生成图片" }).click();
    await page.getByLabel("思考模式").selectOption("deep");
    await openActions(page);
    await page.getByRole("menuitem", { name: "生成图片" }).click();
    await openActions(page);
    assert.equal(await page.getByRole("menuitem", { name: "上传图片" }).isEnabled(), true);
    await page.locator('input[aria-label="选择图片"]').setInputFiles(fileURLToPath(new URL("../build/icon.png", import.meta.url)));
    await page.getByRole("button", { name: "移除附件 icon.png" }).waitFor();
    await page.locator("textarea").fill("把这张参考图改成暖色背景");
    await page.getByRole("button", { name: "生成图片", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("media-task-post:image:a:refs=1") && document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("image-source-validated:1"), null, { timeout: 15000 });
    const events = await evidence(page).innerText();
    assert.ok(events.includes("project-context:A immutable project instructions"));
    assert.equal((events.match(/media-task-post:image:a:refs=1/g) ?? []).length, 1);
    await page.locator(".tp-ai-media-task-reply .tp-ai-generated-image img").waitFor({ timeout: 15000 });
    await page.waitForTimeout(1600); // allow the completed asset association to persist
    await page.getByRole("button", { name: "取消生成图片" }).click();
    await page.locator("textarea").fill("@video 沿用这张图片里的角色做短视频");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("media-task-post:video:a:refs=1") && document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("generated-asset:a:"), null, { timeout: 15000 });
    const boundEvents = await evidence(page).innerText();
    assert.equal((boundEvents.match(/generated-asset:a:/g) ?? []).length, 1);
    assert.equal((boundEvents.match(/media-task-post:video:a:refs=1/g) ?? []).length, 1);
    await page.screenshot({ path: "/tmp/tongpin-generated-image-video-binding.png" });
    assert.deepEqual(errors, []);
    results.imageEdit = { ordinaryVisionGated: true, unconfiguredTierReferenceGated: true, configuredTierReferenceEnabled: true, exactPersistedImageSource: true, generatedImageToVideoBoundToSameConversation: true };
    await context.close();
  }
  {
    const { page, context, errors } = await fixture("&failMediaSave");
    const original = await page.locator("textarea").inputValue();
    assert.ok(original.startsWith("@image "));
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("workspace-media-save-rejected"));
    await page.waitForFunction(value => (document.querySelector("textarea")?.value ?? "") === value, original);
    assert.equal((await evidence(page).innerText()).includes("media-task-post:"), false);
    await page.reload();
    await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
    assert.equal(await page.locator("textarea").inputValue(), original);
    assert.equal((await evidence(page).innerText()).includes("media-task-post:"), false);
    assert.deepEqual(errors, []);
    results.saveFailure = { paidPostPrevented: true, originalDraftRecoveredAfterReload: true };
    await context.close();
  }
  {
    const { page, context, errors } = await fixture("&dispatch");
    await page.locator("textarea").fill("给猫咪来幅画");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("stream:first-delta"));
    await row(page, "B 编辑中").click();
    assert.equal(await row(page, "B 编辑中").getAttribute("aria-current"), "page");
    await page.waitForFunction(() => document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("media-task-post:image:a:refs=0"), null, { timeout: 15000 });
    assert.equal(await row(page, "B 编辑中").getAttribute("aria-current"), "page", "A media continuation must not steal B's focus");
    assert.equal(await page.locator("textarea").inputValue(), "B 的草稿不能丢");
    assert.ok(await page.getByRole("button", { name: "移除附件 B.txt" }).isVisible());
    assert.deepEqual(errors, []);
    results.dispatchFocus = { aMediaContinuedInBackground: true, bFocusAndDraftPreserved: true };
    await context.close();
  }
  {
    const { page, context, errors } = await fixture("&dispatch&fast");
    await page.locator("textarea").fill("给猫咪来幅画");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("media-task-post:image:a:refs=0"), null, { timeout: 15000 });
    await page.locator(".tp-ai-media-task-reply strong").getByText("方案已就绪，等待确认生成额度").waitFor({ timeout: 15000 });
    const events = await evidence(page).innerText();
    assert.ok(events.includes("media-task-grant:image:no"));
    assert.equal((events.match(/media-task-post:image:a:refs=0/g) ?? []).length, 1);
    assert.equal(await page.locator(".tp-ai-message.is-user").count(), 1);
    await page.getByRole("button", { name: "确认额度并生成" }).click();
    await page.waitForFunction(() => document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("media-task-completed:image:a"), null, { timeout: 15000 });
    const authorizedEvents = await evidence(page).innerText();
    assert.equal((authorizedEvents.match(/media-task-authorize:image:a/g) ?? []).length, 1);
    assert.equal((authorizedEvents.match(/media-task-post:image:a:refs=0/g) ?? []).length, 1);
    assert.deepEqual(errors, []);
    results.dispatchImage = { persistedOriginalTurn: true, mediaTaskPostOnce: true, noAutomaticPaidGrant: true, authorizationInline: true, authorizationResumesSameTask: true };
    await context.close();
  }
  {
    const { page, context, errors } = await fixture("&dispatch&fast");
    await openActions(page);
    await page.getByRole("menuitem", { name: "上传图片" }).click();
    await page.locator('input[aria-label="选择图片"]').setInputFiles(fileURLToPath(new URL("../build/icon.png", import.meta.url)));
    await page.getByRole("button", { name: "移除附件 icon.png" }).waitFor();
    await page.locator("textarea").fill("让这个图动起来");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('output[aria-label="验收证据"]')?.textContent?.includes("media-task-post:video:a:refs=1"), null, { timeout: 15000 });
    await page.locator(".tp-ai-media-task-reply strong").getByText("方案已就绪，等待确认生成额度").waitFor({ timeout: 15000 });
    const events = await evidence(page).innerText();
    assert.ok(events.includes("media-task-grant:video:no"));
    assert.equal((events.match(/media-task-post:video:a:refs=1/g) ?? []).length, 1);
    assert.equal(await page.locator(".tp-ai-message.is-user").count(), 1);
    assert.deepEqual(errors, []);
    results.dispatchVideo = { persistedOriginalTurn: true, referenceBoundToSavedTurn: true, mediaTaskPostOnce: true, noAutomaticPaidGrant: true, authorizationInline: true };
    await context.close();
  }
  console.log(JSON.stringify({ kind: "real-components-synthetic-transport", results }, null, 2));
} finally { await browser.close(); }
