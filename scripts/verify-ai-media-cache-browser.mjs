/** Real React chat components with synthetic media, only on loopback Vite :5181. */
import assert from "node:assert/strict";
const { chromium } = await import(process.env.TONGPIN_PLAYWRIGHT_MODULE ?? "playwright");
const run = crypto.randomUUID();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const evidence = () => page.locator('output[aria-label="验收证据"]').innerText();
const count = (source, prefix) => (source.match(new RegExp(prefix, "g")) ?? []).length;
const select = title => page.locator(`.tp-ai-conversation-row__select[title="${title}"]`).click();
async function switchPage() {
  await page.getByRole("button", { name: "切换测试页面" }).click();
  await page.getByText("合成其他页面").waitFor();
  await page.getByRole("button", { name: "切换测试页面" }).click();
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
}
const images = page.locator(".tp-ai-generated-image img");
async function openImages() {
  await page.getByRole("button", { name: "打开成果：两张人物图片", exact: true }).first().click();
  await images.first().waitFor();
}
async function setDenied(value) {
  await page.evaluate(({ key, denied }) => localStorage.setItem(key, denied ? "1" : "0"),
    { key: `tongpin-conversation-acceptance:${run}:deny-media`, denied: value });
}
try {
  await page.goto(`http://127.0.0.1:5181/scripts/ai-conversation-acceptance.html?run=${run}&fast&multiImage&readyVideo&pageSwitch`);
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  await openImages();
  await images.nth(1).waitFor();
  assert.equal(count(await evidence(), "image-content:"), 2);

  await switchPage(); await openImages();
  await page.waitForFunction(() => (document.querySelector('output[aria-label="验收证据"]')?.textContent?.match(/image-check:/g) ?? []).length === 2);
  assert.equal(count(await evidence(), "image-content:"), 2, "cross-conversation remount must not download full images");

  await setDenied(true);
  await switchPage();
  await page.getByRole("button", { name: "打开成果：两张人物图片", exact: true }).first().click();
  await page.waitForFunction(() => (document.querySelector('output[aria-label="验收证据"]')?.textContent?.match(/image-check:/g) ?? []).length === 4);
  assert.equal(await images.count(), 0, "revoked images must remain hidden despite warm memory bytes");
  await setDenied(false);

  await select("C 后台视频");
  const video = page.locator(".tp-ai-video-reply video");
  await video.waitFor();
  assert.equal(count(await evidence(), "video-content:fixture-video-c"), 1);
  await switchPage(); await select("C 后台视频"); await video.waitFor();
  assert.equal(count(await evidence(), "video-content:fixture-video-c"), 1, "cross-conversation remount must not download the MP4");
  assert.equal(count(await evidence(), "video-content-check:fixture-video-c"), 1);

  await setDenied(true);
  await switchPage(); await select("C 后台视频");
  await page.waitForFunction(() => (document.querySelector('output[aria-label="验收证据"]')?.textContent?.match(/video-content-check:fixture-video-c/g) ?? []).length === 2);
  assert.equal(await video.count(), 0, "revoked video must remain hidden despite warm memory bytes");
  await setDenied(false);
  assert.deepEqual(errors, []);
  process.stdout.write(JSON.stringify({ imageFullDownloads: 2, imageWarmChecks: 4, videoFullDownloads: 1, videoWarmChecks: 2, revokedMediaHidden: true }) + "\n");
} finally {
  await context.close();
  await browser.close();
}
