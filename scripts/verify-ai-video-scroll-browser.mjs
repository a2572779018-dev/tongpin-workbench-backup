/** Isolated real-React video mount check. Requires Vite on 127.0.0.1:5181.
 * The fixture uses synthetic transport; no provider/account is contacted. */
import assert from "node:assert/strict";
const { chromium } = await import(process.env.TONGPIN_PLAYWRIGHT_MODULE ?? "playwright");

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:5181/scripts/ai-conversation-acceptance.html?run=${crypto.randomUUID()}&fast`);
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  await page.locator('.tp-ai-conversation-row__select[title="C 后台视频"]').click();
  const video = page.locator(".tp-ai-video-reply video");
  await video.waitFor({ timeout: 20000 });
  const node = await video.elementHandle();
  const evidence = () => page.locator('output[aria-label="验收证据"]').innerText();
  const count = text => (text.match(/video-content:fixture-video-c/g) ?? []).length;
  const first = count(await evidence());
  assert.equal(first, 1, "first mount must authorize video content exactly once");

  await page.evaluate(() => {
    const list = document.querySelector(".tp-ai-messages");
    list.style.paddingTop = "1800px";
    list.scrollTop = 0;
  });
  await page.waitForTimeout(350);
  assert.equal(await node.evaluate(element => element.isConnected), true, "scrolling away must not unmount the authorized player");
  await page.locator(".tp-ai-video-reply").scrollIntoViewIfNeeded();
  await video.waitFor();
  await page.waitForTimeout(350);
  assert.equal(count(await evidence()), first, "scrolling back must not re-download the video");
  assert.equal(await node.evaluate(element => element.isConnected), true, "the same player must survive scrolling");
  await page.locator('.tp-ai-conversation-row__select[title="B 编辑中"]').click();
  await page.waitForFunction(() => !document.querySelector(".tp-ai-video-reply video"));
  assert.equal(await node.evaluate(element => element.isConnected), false, "leaving the conversation must release its player");
  await page.locator('.tp-ai-conversation-row__select[title="C 后台视频"]').click();
  await page.locator(".tp-ai-video-reply").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => (document.querySelector('output[aria-label="验收证据"]')?.textContent?.match(/video-content:fixture-video-c/g) ?? []).length === 2);
  await video.waitFor();
  assert.equal(count(await evidence()), 2, "a new mount must re-authorize private video content");
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ playerRetained: true, sameMountDownloads: first, newMountDownloads: 2 }) + "\n");
} finally {
  await context.close();
  await browser.close();
}
