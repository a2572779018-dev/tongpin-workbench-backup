/** Read-only loopback fixture QA. Does not use the native app, real accounts, or AI services. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.join(__dirname, "..");
const ORIGIN = "http://127.0.0.1:5174";
const OUT = process.env.TONGPIN_LAYOUT_QA_OUT || "/Users/sam/Documents/ChatGPT/个人/tongpin-release-downloads/qa-character-layout-20260908";
const PW = "/Users/sam/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const report = { startedAt: new Date().toISOString(), origin: ORIGIN, isolatedFixture: true, checks: [], errors: [], blockedRequests: [], localOnlyWorkspaceAcks: 0, screenshots: [] };
const sources = ["src/features/tongpin-ai/ai-refinements.css", "src/features/tongpin-ai/chat-layout.css", "src/features/tongpin-ai/ChatWorkspace.tsx", "src/features/tongpin-ai/visuals/TongpinAICharacter.tsx"];
let browser;
const pause = (page, milliseconds) => page.waitForTimeout(milliseconds);
async function digests() { return Object.fromEntries(await Promise.all(sources.map(async file => [file, crypto.createHash("sha256").update(await fs.readFile(path.join(ROOT, file))).digest("hex")]))); }
async function sample(page) {
  return page.locator(".tp-ai-chat .tp-ai-character").evaluate(character => {
    const svg = character.querySelector("svg");
    const r = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
    const chat = character.closest(".tp-ai-chat"), list = chat.querySelector(".tp-ai-messages"), header = chat.querySelector(".tp-ai-chat__header");
    const frame = svg.querySelector(":scope > g"), body = frame.querySelector(":scope > use");
    const glyph = frame.querySelector(":scope > g[filter] > path");
    const eyeLayers = frame.querySelectorAll(":scope > g[clip-path]"), eyes = eyeLayers[eyeLayers.length - 1].querySelectorAll(":scope > path");
    const leftEye = r(eyes[6]), rightEye = r(eyes[7]), bodyBox = r(body);
    const heading = chat.querySelector(".tp-ai-chat-welcome h1");
    return { wrapper: r(character), svg: r(svg), body: bodyBox, glyph: glyph && Number(glyph.getAttribute("opacity")) > 0 ? r(glyph) : null, header: r(header), list: r(list), scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, heading: heading ? r(heading) : null, eyes: { x: (leftEye.x + leftEye.width / 2 + rightEye.x + rightEye.width / 2) / 2 - bodyBox.x - bodyBox.width / 2, y: (leftEye.y + leftEye.height / 2 + rightEye.y + rightEye.height / 2) / 2 - bodyBox.y - bodyBox.height / 2 }, horizontalOverflow: document.documentElement.scrollWidth > innerWidth, invalidPaths: Array.from(svg.querySelectorAll("path")).some(p => /NaN|Infinity/.test(p.getAttribute("d") || "")) };
  });
}
function contained(inner, outer, note, allowance = 1) {
  assert.ok(inner.x >= outer.x - allowance && inner.y >= outer.y - allowance && inner.right <= outer.right + allowance && inner.bottom <= outer.bottom + allowance, `${note}: ${JSON.stringify({ inner, outer })}`);
}
function verifySample(value, placement) {
  assert.equal(value.horizontalOverflow, false); assert.equal(value.invalidPaths, false);
  contained(value.svg, value.wrapper, "SVG must fit the layout slot");
  contained(value.body, value.svg, "Flower must fit SVG", 3);
  if (value.glyph) contained(value.glyph, value.svg, "Expression must fit SVG", 3);
  if (placement === "header") {
    contained(value.wrapper, value.header, "Avatar must occupy the header rather than cross the divider");
    assert.ok(Math.max(value.body.bottom, value.glyph?.bottom || 0) < value.header.bottom - 4, "Visible avatar needs clearance above the divider");
  } else {
    assert.equal(value.scrollTop, 0, "Empty state must start at its top, not scroll the character out of view");
    contained(value.wrapper, value.list, "Welcome avatar must remain in the visible message viewport");
    assert.ok(value.heading.y - value.wrapper.bottom >= 8, "Welcome title must not overlap the avatar");
  }
}
async function fixture(viewport, placement, expression) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "no-preference" });
  const account = placement === "header" ? "long" : "ready";
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.host === "127.0.0.1:4319" && url.pathname === "/api/ai/workspace" && request.method() === "PUT") {
      // The empty-state hydration may normalize an old fixture snapshot. Acknowledge
      // it in this isolated page only; do not mutate even the shared fixture store.
      const body = request.postDataJSON(); report.localOnlyWorkspaceAcks += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: body.expectedRevision + 1, schemaVersion: 1, state: body.state, updatedAt: new Date().toISOString() }) }); return;
    }
    if (!["127.0.0.1:5174", "127.0.0.1:4319"].includes(url.host) || (!["GET", "HEAD"].includes(request.method()) && !(request.method() === "POST" && url.pathname === "/api/auth/login"))) {
      report.blockedRequests.push({ host: url.host, path: url.pathname, method: request.method() }); await route.abort("blockedbyclient"); return;
    }
    if (url.pathname === "/api/ai/persona") {
      const response = await route.fetch(), body = await response.json(); body.profile.expression = expression;
      await route.fulfill({ response, json: body }); return;
    }
    if (url.pathname === "/api/ai/workspace" && placement === "welcome") {
      const response = await route.fetch(), body = await response.json(); body.state = null;
      await route.fulfill({ response, json: body }); return;
    }
    await route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") report.errors.push(message.text()); });
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "邮箱", exact: true }).fill(`${account}@tongpin.test`);
  await page.locator('input[type="password"]').fill("Fixture123!");
  await page.getByRole("button", { name: "登录同频", exact: true }).click();
  const tab = page.getByRole("button", { name: "同频 AI", exact: true });
  await tab.focus(); await tab.press("Enter");
  await page.waitForFunction(() => (document.querySelector('.tp-ai-chat .tp-ai-character defs > path[id^="ch-head-"]')?.getAttribute("d") || "").length > 100);
  await pause(page, 350);
  return { page, context };
}
async function main() {
  assert.equal(process.argv.length, 2); await fs.mkdir(OUT, { recursive: true }); report.sourceDigestsAtStart = await digests();
  browser = await require(PW).chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  for (const viewport of [{ width: 1203, height: 769 }, { width: 1440, height: 1000 }]) for (const placement of ["welcome", "header"]) for (const expression of ["question", "smitten"]) {
    const name = `${placement}-${expression}-${viewport.width}x${viewport.height}`;
    let page, context; const samples = [];
    try {
      ({ page, context } = await fixture(viewport, placement, expression));
      assert.equal(await page.locator(".tp-ai-sync-error").count(), 0, "Fixture must not show a persistence failure banner");
      for (const point of [[4, 4], [viewport.width - 4, 4], [4, viewport.height - 4], [viewport.width - 4, viewport.height - 4]]) {
        await page.mouse.move(...point); await pause(page, 450); const value = await sample(page); samples.push({ point, ...value }); verifySample(value, placement);
      }
      const tools = page.getByRole("button", { name: "选择工具", exact: true });
      await tools.hover(); await pause(page, 600); const before = await sample(page);
      await tools.click(); await pause(page, 100); const after = await sample(page); verifySample(after, placement);
      assert.equal(await page.locator(".tp-ai-sync-error").count(), 0, "Fixture must not show a persistence failure banner");
      assert.ok(Math.abs(after.eyes.x - before.eyes.x) < 2.5 && Math.abs(after.eyes.y - before.eyes.y) < 2.5, "Click must not reverse the settled look direction");
      await page.keyboard.press("Escape");
      report.checks.push({ name, passed: true, samples, click: { before: before.eyes, after: after.eyes } });
      console.log(JSON.stringify({ name, passed: true }));
    } catch (error) {
      report.checks.push({ name, passed: false, error: error.message, samples }); console.log(JSON.stringify({ name, passed: false, error: error.message.slice(0, 600) }));
    } finally {
      if (page && !page.isClosed()) { const file = path.join(OUT, `${name}.png`); await page.screenshot({ path: file }); report.screenshots.push(file); }
      await context?.close();
    }
  }
}
main().catch(error => { report.fatal = error.message; }).finally(async () => {
  await browser?.close(); report.completedAt = new Date().toISOString(); report.sourceDigestsAtEnd = await digests();
  report.sourceUnchanged = JSON.stringify(report.sourceDigestsAtStart) === JSON.stringify(report.sourceDigestsAtEnd);
  report.passed = !report.fatal && report.checks.length === 8 && report.checks.every(check => check.passed) && !report.errors.length && !report.blockedRequests.length && report.sourceUnchanged;
  await fs.writeFile(path.join(OUT, "character-layout-summary.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, output: OUT, errors: report.errors, blockedRequests: report.blockedRequests })); process.exitCode = report.passed ? 0 : 1;
});
