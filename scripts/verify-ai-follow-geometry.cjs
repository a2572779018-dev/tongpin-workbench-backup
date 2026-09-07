/** Isolated fixture-only SVG geometry checks; never save a persona or send chat. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const OUT = "/Users/sam/Documents/ChatGPT/个人/tongpin-release-downloads/qa-0.1.38";
const PW = "/Users/sam/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const report = { version: "0.1.38-candidate", startedAt: new Date().toISOString(), checks: [], errors: [], blockedWrites: [], screenshots: [], fixtureExpressionOverrides: [], personaWrites: 0, chatRequests: 0 };
let browser, currentPage;
async function sourceDigests() {
  const files = ["src/components/CustomCursor.tsx", "src/features/tongpin-ai/visuals/fleur/FleurCharacter.tsx", "src/features/tongpin-ai/visuals/fleur/character-runtime.js", "src/features/tongpin-ai/visuals/fleur/pointerFollow.ts", "src/features/tongpin-ai/visuals/fleur/visibleFrameLoop.ts"];
  return Object.fromEntries(await Promise.all(files.map(async file => [file, crypto.createHash("sha256").update(await fs.readFile(path.join(__dirname, "..", file))).digest("hex")])));
}
const pause = (page, ms) => page.waitForTimeout(ms);
async function record(name, run) {
  try { const details = await run(); report.checks.push({ name, passed: true, details }); console.log(JSON.stringify({ name, passed: true })); return details; }
  catch (error) { report.checks.push({ name, passed: false, error: String(error.message).slice(0, 2500) }); console.log(JSON.stringify({ name, passed: false, error: String(error.message).slice(0, 1200) })); return null; }
}
async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`); await page.screenshot({ path: file }); report.screenshots.push(file);
}
async function geometry(page, selector) {
  return page.locator(selector).first().evaluate(element => {
    const svg = element.querySelector("svg"), group = svg.querySelector(":scope > g");
    const body = group.querySelector(":scope > use");
    const layers = group.querySelectorAll(":scope > g[clip-path]");
    const paths = layers[layers.length - 1].querySelectorAll(":scope > path");
    const eyes = [paths[6], paths[7]];
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, centerX: r.x + r.width / 2, centerY: r.y + r.height / 2 }; };
    const bodyRect = rect(body), eyeRects = eyes.map(rect), svgRect = rect(svg), box = rect(element);
    const eyeCenter = { x: (eyeRects[0].centerX + eyeRects[1].centerX) / 2, y: (eyeRects[0].centerY + eyeRects[1].centerY) / 2 };
    const glyph = group.querySelector(":scope > g[filter] > path"), glyphRect = glyph && Number(glyph.getAttribute("opacity")) > 0 ? rect(glyph) : null;
    const heading = element.closest(".tp-ai-chat-welcome")?.querySelector("h1,h2");
    const ctm = svg.getScreenCTM();
    return { at: performance.now(), box, svg: svgRect, body: bodyRect, eyeRects, eyes: eyeCenter, eyeRelativeX: eyeCenter.x - bodyRect.centerX, eyeRelativeY: eyeCenter.y - bodyRect.centerY, origin: { x: ctm.e, y: ctm.f }, glyph: glyphRect, heading: heading ? rect(heading) : null, invalidPaths: Array.from(svg.querySelectorAll("path")).filter(p => /NaN|Infinity/.test(p.getAttribute("d") || "")).length };
  });
}
function checkBounds(g) {
  assert.equal(g.invalidPaths, 0);
  for (const [name, r] of [["body", g.body], ["glyph", g.glyph]]) if (r) {
    assert.ok(r.x >= g.svg.x - 3 && r.y >= g.svg.y - 3 && r.right <= g.svg.right + 3 && r.bottom <= g.svg.bottom + 3, `${name} outside SVG: ${JSON.stringify(g)}`);
  }
  if (g.heading) assert.ok(g.heading.y - Math.max(g.body.bottom, g.glyph?.bottom || 0) >= 8, JSON.stringify(g));
}
async function average(page, selector, count = 4) {
  const samples = [];
  for (let i = 0; i < count; i++) { samples.push(await geometry(page, selector)); await pause(page, 90); }
  for (const g of samples) checkBounds(g);
  return { eyeRelativeX: samples.reduce((sum, g) => sum + g.eyeRelativeX, 0) / count, eyeRelativeY: samples.reduce((sum, g) => sum + g.eyeRelativeY, 0) / count, bodyWidth: samples.reduce((sum, g) => sum + g.body.width, 0) / count, samples };
}
async function newFixture(account, expression) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    const read = ["GET", "HEAD"].includes(request.method());
    if (!["127.0.0.1:5174", "127.0.0.1:4319"].includes(url.host) || (!read && !(request.method() === "POST" && url.pathname === "/api/auth/login"))) {
      report.blockedWrites.push({ method: request.method(), pathname: url.pathname }); await route.abort("blockedbyclient"); return;
    }
    if (expression && request.method() === "GET" && url.pathname === "/api/ai/persona") {
      const response = await route.fetch(); const body = await response.json();
      assert.ok(body.profile); body.profile.expression = expression;
      report.fixtureExpressionOverrides.push({ account, expression, method: "GET response only; server storage unchanged" });
      await route.fulfill({ response, json: body }); return;
    }
    await route.continue();
  });
  const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(10000);
  page.on("pageerror", e => report.errors.push({ account, expression, kind: "pageerror", text: e.message.slice(0, 1000) }));
  page.on("console", m => { if (m.type() === "error") report.errors.push({ account, expression, kind: "console", text: m.text().slice(0, 1000) }); });
  await page.goto("http://127.0.0.1:5174", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "邮箱", exact: true }).fill(`${account}@tongpin.test`);
  await page.locator('input[type="password"]').fill("Fixture123!");
  await page.getByRole("button", { name: "登录同频", exact: true }).click();
  const ai = page.getByRole("button", { name: "同频 AI", exact: true });
  await ai.waitFor(); await pause(page, 300); const r = await ai.boundingBox();
  // Real mouse click, not keyboard navigation, reproduces the reported entry.
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await page.locator("#tp-ai-message-input").waitFor();
  await page.waitForFunction(() => (document.querySelector('.tp-ai-chat .tp-ai-character defs > path[id^="ch-head-"]')?.getAttribute("d") || "").length > 100);
  return { context, page };
}
async function directionSet(page, selector, name, screenshots = true) {
  const initial = await geometry(page, selector), viewport = page.viewportSize(), result = {};
  const points = {
    left: [Math.max(5, initial.origin.x - 400), initial.origin.y],
    right: [Math.min(viewport.width - 5, initial.origin.x + 400), initial.origin.y],
    up: [initial.origin.x, Math.max(5, initial.origin.y - 300)],
    down: [initial.origin.x, Math.min(viewport.height - 5, initial.origin.y + 300)],
  };
  for (const [direction, point] of Object.entries(points)) {
    await page.mouse.move(...point); await pause(page, 650);
    result[direction] = { point, ...await average(page, selector) };
    if (screenshots) await shot(page, `${name}-${direction}`);
  }
  const horizontalPixels = result.right.eyeRelativeX - result.left.eyeRelativeX;
  const verticalPixels = result.down.eyeRelativeY - result.up.eyeRelativeY;
  const bodyWidth = (result.right.bodyWidth + result.left.bodyWidth) / 2;
  assert.ok(horizontalPixels >= bodyWidth * .015, `Right must face right; ${JSON.stringify({ horizontalPixels, bodyWidth, result })}`);
  assert.ok(verticalPixels >= bodyWidth * .01, `Up must face up; ${JSON.stringify({ verticalPixels, bodyWidth, result })}`);
  return { horizontalPixels, verticalPixels, horizontalFraction: horizontalPixels / bodyWidth, verticalFraction: verticalPixels / bodyWidth, result };
}
async function corners(page, selector, name) {
  const values = [], v = page.viewportSize();
  for (const point of [[5, 5], [v.width - 5, 5], [5, v.height - 5], [v.width - 5, v.height - 5]]) {
    await page.mouse.move(...point); await pause(page, 500); const g = await geometry(page, selector); checkBounds(g); values.push({ point, ...g });
  }
  await shot(page, `${name}-corner`); return values;
}

async function main() {
  assert.equal(process.argv.length, 2); await fs.mkdir(OUT, { recursive: true });
  report.sourceDigestsAtStart = await sourceDigests();
  const { chromium } = require(process.env.PW_MODULE || PW);
  browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const timeout = setTimeout(() => void browser.close(), 180000); timeout.unref();
  try {
    const main = await newFixture("ready", "auto"); const page = main.page, selector = ".tp-ai-chat .tp-ai-character";
    await record("real-click-ai-entry-visible-four-direction-follow", () => directionSet(page, selector, "welcome-auto"));
    await record("stationary-pointer-holds-direction-past-1-point-2-seconds", async () => {
      const g = await geometry(page, selector); await page.mouse.move(g.origin.x + 350, g.origin.y); await pause(page, 650);
      const early = await average(page, selector); await pause(page, 1800); const late = await average(page, selector);
      assert.ok(late.eyeRelativeX > 1, JSON.stringify({ early, late }));
      assert.ok(Math.abs(late.eyeRelativeX - early.eyeRelativeX) < 2.5, JSON.stringify({ early, late }));
      return { early, late };
    });
    await record("blank-and-tools-clicks-do-not-reverse-same-pointer", async () => {
      const target = await geometry(page, selector), blank = [target.origin.x + 300, target.origin.y];
      await page.mouse.move(...blank); await pause(page, 650); const beforeBlank = await average(page, selector);
      await page.mouse.click(...blank); const afterBlank = await average(page, selector);
      assert.ok(Math.abs(beforeBlank.eyeRelativeX - afterBlank.eyeRelativeX) < 2.5);
      const tools = page.getByRole("button", { name: "选择工具", exact: true });
      await tools.hover(); await pause(page, 650); const beforeTools = await average(page, selector);
      await tools.click(); const afterTools = await average(page, selector);
      assert.ok(Math.abs(beforeTools.eyeRelativeY - afterTools.eyeRelativeY) < 2.5);
      await page.keyboard.press("Escape");
      return { beforeBlank, afterBlank, beforeTools, afterTools };
    });
    const settingsButton = page.getByRole("button", { name: "专属 AI 设置", exact: true });
    await settingsButton.hover(); await pause(page, 650);
    const settingsButtonBox = await settingsButton.boundingBox();
    await settingsButton.click();
    await page.getByRole("dialog", { name: "我的专属 AI", exact: true }).waitFor();
    await page.locator(".tp-ai-expression-picker").scrollIntoViewIfNeeded();
    await pause(page, 100);
    await record("settings-layout-reanchors-existing-pointer-without-new-move", async () => {
      const samples = await average(page, ".tp-ai-persona-dialog .tp-ai-character");
      assert.ok(samples.eyeRelativeX > 1 && samples.eyeRelativeY < -1, JSON.stringify(samples));
      return { pointerUnchangedSinceClick: { x: settingsButtonBox.x + settingsButtonBox.width / 2, y: settingsButtonBox.y + settingsButtonBox.height / 2 }, scrolledPickerIntoViewWithoutPointerMove: true, ...samples };
    });
    for (const [expression, index] of [["question", 3], ["smitten", 6]]) {
      await page.locator(".tp-ai-expression-grid button").nth(index).click();
      await record(`settings-${expression}-visible-follow-after-click`, () => directionSet(page, ".tp-ai-persona-dialog .tp-ai-character", `settings-${expression}`));
      await record(`settings-${expression}-four-corner-boundaries`, () => corners(page, ".tp-ai-persona-dialog .tp-ai-character", `settings-${expression}`));
    }
    await page.getByRole("button", { name: "关闭专属 AI 设置", exact: true }).click();
    await main.context.close();
    for (const account of ["ready", "long"]) for (const expression of ["question", "smitten"]) {
      const variant = await newFixture(account, expression), name = `${account === "ready" ? "welcome" : "header"}-${expression}`;
      try {
        await record(`${name}-visible-four-direction-follow`, () => directionSet(variant.page, selector, name, account === "ready"));
        await record(`${name}-four-corner-boundaries`, () => corners(variant.page, selector, name));
      } finally { await variant.context.close(); }
    }
    await record("no-invalid-svg-console-errors-or-storage-writes", async () => {
      assert.deepEqual(report.errors, []); assert.deepEqual(report.blockedWrites, []);
      return { consoleErrors: 0, storageWrites: 0, chatRequests: 0 };
    });
  } finally { clearTimeout(timeout); await browser.close(); }
}

main().catch(error => { report.fatal = String(error.message).slice(0, 1800); console.error(JSON.stringify({ fatal: report.fatal })); }).finally(async () => {
  await browser?.close().catch(() => {}); report.completedAt = new Date().toISOString();
  report.sourceDigestsAtEnd = await sourceDigests();
  report.sourceUnchangedDuringMeasurement = JSON.stringify(report.sourceDigestsAtStart) === JSON.stringify(report.sourceDigestsAtEnd);
  report.passed = !report.fatal && report.checks.every(c => c.passed) && report.sourceUnchangedDuringMeasurement;
  report.measurementBoundary = "Screen-space rendered SVG eye centers relative to body bounds, plus actual mouse clicks and visual screenshots. Expression overrides are isolated GET response fixtures only, never persisted to a member account. Not a physical trackpad or user-perceived smoothness guarantee.";
  await fs.mkdir(OUT, { recursive: true }); const output = path.join(OUT, "follow-geometry-summary.json");
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); console.log(JSON.stringify({ passed: report.passed, report: output })); process.exitCode = report.passed ? 0 : 1;
});
