/** Isolated loopback-only browser QA. Never attach a user profile or a production account. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const UI = "http://127.0.0.1:5174";
const OUT = "/Users/sam/Documents/ChatGPT/个人/tongpin-release-downloads/qa-0.1.37";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_PW = "/Users/sam/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const EXPRESSIONS = ["auto", "none", "hmm", "question", "zzz", "aha", "smitten", "oh", "yes", "nope", "meh", "grr", "wow", "woozy"];
const report = { version: "0.1.37", startedAt: new Date().toISOString(), origin: UI, isolatedHeadlessContext: true, productionRequestsAllowed: false, checks: [], screenshots: [], errors: [], blockedExternalRequests: [] };
let browser;
let activePage;

const hash = value => crypto.createHash("sha256").update(value || "").digest("hex");
async function check(name, run) {
  try {
    const details = await run();
    report.checks.push({ name, passed: true, details });
    console.log(JSON.stringify({ stage: name, passed: true }));
    return details;
  } catch (error) {
    report.checks.push({ name, passed: false, error: String(error.message).slice(0, 800) });
    console.log(JSON.stringify({ stage: name, passed: false, error: String(error.message).slice(0, 400) }));
    if (activePage && !activePage.isClosed()) await screenshot(activePage, `failure-${report.checks.length}`).catch(() => {});
    return null;
  }
}
async function screenshot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  report.screenshots.push(file);
}
async function newContext(name, failCharacter = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: "no-preference" });
  const local = new Set(["127.0.0.1:5174", "127.0.0.1:4319"]);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (!local.has(url.host) && !["data:", "blob:"].includes(url.protocol)) {
      report.blockedExternalRequests.push({ context: name, host: url.host });
      await route.abort("blockedbyclient"); return;
    }
    if (failCharacter && /\/visuals\/fleur\/FleurCharacter\.tsx(?:\?|$)/.test(url.pathname + url.search)) {
      await route.abort("failed"); return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => report.errors.push({ context: name, kind: "pageerror", text: error.message.slice(0, 600), expectedChunkFailure: false }));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const text = message.text();
    report.errors.push({ context: name, kind: "console", text: text.slice(0, 700), expectedChunkFailure: failCharacter && /FleurCharacter|dynamically imported module|Failed to load resource|CharacterBoundary|React will try to recreate/i.test(text) });
  });
  return { context, page };
}
async function login(page, kind) {
  activePage = page;
  await page.goto(UI, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "邮箱", exact: true }).fill(`${kind}@tongpin.test`);
  await page.locator('input[type="password"]').fill("Fixture123!");
  await page.getByRole("button", { name: "登录同频", exact: true }).click();
  await enterAi(page);
}
async function enterAi(page) {
  // App-level view intentionally returns to tasks after reload. Enter via the
  // keyboard so home-page entrance animation does not defeat pointer stability.
  const tab = page.getByRole("button", { name: "同频 AI", exact: true });
  await tab.focus(); await tab.press("Enter");
  await page.locator(".tp-ai-character").first().waitFor();
  await page.waitForTimeout(250);
}
async function openSettings(page) {
  await page.getByRole("button", { name: "专属 AI 设置", exact: true }).click();
  await page.getByRole("dialog", { name: "我的专属 AI", exact: true }).waitFor();
  await page.locator(".tp-ai-expression-grid button").first().waitFor();
}
async function characterSnapshot(page, selector = ".tp-ai-chat .tp-ai-character") {
  return page.locator(selector).first().evaluate(element => {
    const svg = element.querySelector("svg");
    const box = element.getBoundingClientRect();
    const glyph = svg?.querySelector('g[filter] > path');
    const head = svg?.querySelector('defs > path[id^="ch-head-"]');
    const eyes = svg ? Array.from(svg.querySelectorAll('g[clip-path] > path')).map(p => p.getAttribute("d") || "").join("|") : "";
    const b = svg?.viewBox.baseVal;
    return { x: box.x, y: box.y, width: box.width, height: box.height, svg: Boolean(svg), head: head?.getAttribute("d") || "", eyes, glyph: glyph?.getAttribute("d") || "", glyphOpacity: glyph?.getAttribute("opacity"), viewBox: b ? [b.x, b.y, b.width, b.height] : [] };
  });
}
async function countFrames(page, milliseconds = 1250, selector = ".tp-ai-chat .tp-ai-character") {
  return page.locator(selector).first().evaluate((element, duration) => new Promise(resolve => {
    const head = element.querySelector('defs > path[id^="ch-head-"]');
    let frames = 0;
    const observer = new MutationObserver(records => { frames += records.filter(record => record.attributeName === "d").length; });
    observer.observe(head, { attributes: true, attributeFilter: ["d"] });
    const start = performance.now();
    setTimeout(() => { observer.disconnect(); resolve({ frames, milliseconds: performance.now() - start }); }, duration);
  }), milliseconds);
}

async function verifyWelcomeLayout(page) {
  return check("welcome-fixed-expression-layout-at-corners", async () => {
    const outcomes = [];
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1023, height: 933 }, { width: 720, height: 933 }]) {
      await page.setViewportSize(viewport);
      const backdrop = page.getByRole("button", { name: "关闭侧边栏", exact: true });
      if (await backdrop.isVisible()) await backdrop.click();
      for (const expression of ["question", "smitten"]) {
        await openSettings(page);
        await page.locator(".tp-ai-expression-grid button").nth(EXPRESSIONS.indexOf(expression)).click();
        const saved = page.waitForResponse(r => r.url().endsWith("/api/ai/persona") && r.request().method() === "PUT");
        await page.getByRole("button", { name: "保存记忆", exact: true }).click();
        assert.equal((await saved).status(), 200);
        await page.getByRole("dialog", { name: "我的专属 AI", exact: true }).waitFor({ state: "hidden" });
        await page.waitForTimeout(200);
        const samples = [];
        for (const corner of [[2, 2], [viewport.width - 2, 2], [2, viewport.height - 2], [viewport.width - 2, viewport.height - 2]]) {
          await page.mouse.move(...corner); await page.waitForTimeout(250);
          const geometry = await page.locator(".tp-ai-chat-welcome").evaluate(welcome => {
            const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
            const figure = welcome.querySelector(".tp-ai-character");
            const svg = figure.querySelector("svg");
            const heading = welcome.querySelector("h1, h2");
            const figureRect = rect(figure), svgRect = rect(svg), headingRect = rect(heading);
            return { figure: figureRect, svg: svgRect, heading: headingRect, gap: headingRect.y - svgRect.bottom, horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
          });
          assert.ok(geometry.svg.width <= geometry.figure.width + 0.5, JSON.stringify(geometry));
          assert.ok(geometry.svg.height <= geometry.figure.height + 0.5, JSON.stringify(geometry));
          assert.ok(geometry.gap >= 15.5, JSON.stringify(geometry));
          assert.equal(geometry.horizontalOverflow, false);
          samples.push({ pointer: corner, ...geometry });
        }
        await screenshot(page, `07-welcome-${expression}-${viewport.width}`);
        outcomes.push({ viewport, expression, samples });
      }
    }
    // Restore only this disposable fixture account, with no conversation request.
    await openSettings(page); await page.locator(".tp-ai-expression-grid button").first().click();
    await page.getByRole("button", { name: "保存记忆", exact: true }).click();
    await page.getByRole("dialog", { name: "我的专属 AI", exact: true }).waitFor({ state: "hidden" });
    return outcomes;
  });
}

async function verifyDirectionalCursor(page) {
  const snapshot = () => page.evaluate(() => {
    const cursor = document.querySelector(".custom-cursor");
    return {
      count: document.querySelectorAll(".custom-cursor").length,
      appView: document.documentElement.dataset.appView,
      enabled: document.documentElement.classList.contains("custom-cursor-enabled"),
      visible: cursor.classList.contains("custom-cursor--visible"),
      hidden: cursor.hidden,
      translation: cursor.style.transform,
      rotation: cursor.querySelector("svg").style.transform,
      inputCursor: getComputedStyle(document.querySelector("#tp-ai-message-input") || document.body).cursor,
    };
  });
  await check("directional-arrow-follows-four-directions", async () => {
    await page.mouse.move(500, 220); await page.waitForTimeout(60);
    const values = [];
    for (const [name, x, y, angle] of [["right", 700, 220, 90], ["down", 700, 270, 180], ["left", 500, 270, 270], ["up", 500, 220, 0]]) {
      await page.mouse.move(x, y); await page.waitForTimeout(60);
      const state = await snapshot();
      const parsed = Number(state.rotation.match(/rotate\(([-.\d]+)deg\)/)?.[1]);
      const normalized = ((parsed % 360) + 360) % 360;
      assert.equal(state.count, 1); assert.equal(state.enabled, true); assert.equal(state.visible, true);
      assert.ok(Math.abs(normalized - angle) < 0.1, JSON.stringify({ name, angle, state }));
      values.push({ name, x, y, expectedAngle: angle, ...state });
    }
    await screenshot(page, "09-directional-cursor");
    return values;
  });
  await check("stationary-arrow-has-no-idle-style-writes", async () => {
    const counts = await page.locator(".custom-cursor").evaluate(cursor => new Promise(resolve => {
      let writes = 0;
      const observer = new MutationObserver(records => { writes += records.length; });
      observer.observe(cursor, { attributes: true, attributeFilter: ["style"], subtree: true });
      const started = performance.now();
      setTimeout(() => { observer.disconnect(); resolve({ writes, milliseconds: performance.now() - started }); }, 750);
    }));
    assert.equal(counts.writes, 0);
    return counts;
  });
  await check("input-restores-native-text-cursor", async () => {
    await page.locator("#tp-ai-message-input").hover(); await page.waitForTimeout(80);
    const state = await snapshot();
    assert.equal(state.enabled, false); assert.equal(state.visible, false); assert.equal(state.inputCursor, "text");
    return state;
  });
  await check("disabled-and-select-keep-native-cursor", async () => {
    const disabled = page.getByRole("button", { name: "发送消息", exact: true });
    assert.equal(await disabled.isDisabled(), true);
    await disabled.hover(); await page.waitForTimeout(60);
    const button = await disabled.evaluate(element => ({ cursor: getComputedStyle(element).cursor, enabled: document.documentElement.classList.contains("custom-cursor-enabled"), visible: document.querySelector(".custom-cursor").classList.contains("custom-cursor--visible") }));
    assert.equal(button.enabled, false); assert.equal(button.visible, false); assert.equal(button.cursor, "not-allowed");
    // A controlled temporary native select exercises the global CSS cascade;
    // this does not claim an otherwise absent select is part of the chat UI.
    await page.evaluate(() => {
      const select = document.createElement("select"); select.id = "qa-native-select";
      select.style.cssText = "position:fixed;left:500px;top:210px;width:130px;height:36px;z-index:9999";
      select.append(new Option("仅本地光标验收", "fixture")); document.querySelector(".tp-ai-chat").append(select);
    });
    try {
      await page.locator("#qa-native-select").hover(); await page.waitForTimeout(60);
      const select = await page.locator("#qa-native-select").evaluate(element => ({ cursor: getComputedStyle(element).cursor, enabled: document.documentElement.classList.contains("custom-cursor-enabled"), visible: document.querySelector(".custom-cursor").classList.contains("custom-cursor--visible") }));
      assert.equal(select.enabled, false); assert.equal(select.visible, false); assert.equal(select.cursor, "auto");
      return { disabledButton: button, temporaryNativeSelect: select, method: "Real disabled send button plus temporary native select in isolated fixture only" };
    } finally { await page.locator("#qa-native-select").evaluate(element => element.remove()); }
  });
  await check("blur-leave-hidden-cancel-pending-paint", async () => {
    const results = [];
    for (const kind of ["blur", "leave", "hidden"]) {
      await page.mouse.move(500, 220); await page.waitForTimeout(60);
      const cancellation = await page.evaluate(kind => new Promise(resolve => {
        const cursor = document.querySelector(".custom-cursor");
        let writes = 0;
        const observer = new MutationObserver(records => { writes += records.length; });
        observer.observe(cursor, { attributes: true, attributeFilter: ["style"], subtree: true });
        // Queue and cancel within one task; the synthetic event is fixture-only.
        document.querySelector(".tp-ai-chat").dispatchEvent(new PointerEvent("pointermove", { clientX: 520, clientY: 230, pointerType: "mouse", bubbles: true }));
        if (kind === "blur") window.dispatchEvent(new Event("blur"));
        if (kind === "leave") document.dispatchEvent(new PointerEvent("pointerout", { relatedTarget: null }));
        if (kind === "hidden") {
          Object.defineProperty(document, "hidden", { configurable: true, value: true });
          document.dispatchEvent(new Event("visibilitychange"));
        }
        setTimeout(() => {
          observer.disconnect();
          const result = { kind, writes, enabled: document.documentElement.classList.contains("custom-cursor-enabled"), visible: cursor.classList.contains("custom-cursor--visible") };
          if (kind === "hidden") { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); }
          resolve(result);
        }, 120);
      }), kind);
      assert.equal(cancellation.writes, 0); assert.equal(cancellation.enabled, false); assert.equal(cancellation.visible, false);
      results.push(cancellation);
    }
    return results;
  });
  await check("reduced-motion-arrow-keeps-fixed-angle", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.mouse.move(500, 220); await page.waitForTimeout(60);
    await page.mouse.move(700, 270); await page.waitForTimeout(60);
    const state = await snapshot(); assert.equal(state.rotation, "rotate(0deg)"); assert.equal(state.count, 1);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    return state;
  });
  await check("ai-and-tasks-share-one-arrow", async () => {
    const tasks = page.getByRole("button", { name: "我的任务", exact: true });
    await tasks.focus(); await tasks.press("Enter");
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".custom-cursor").count(), 1);
    assert.notEqual(await page.evaluate(() => document.documentElement.dataset.appView), "ai");
    await enterAi(page);
    await page.mouse.move(600, 220); await page.waitForTimeout(60);
    const state = await snapshot(); assert.equal(state.count, 1); assert.equal(state.appView, "ai");
    return state;
  });
  await check("directional-cursor-no-browser-errors", async () => {
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors).slice(0, 1000));
    return { pageErrors: 0, consoleErrors: 0 };
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--inspect", "--layout", "--cursor"].includes(arg))) throw new Error("Only --inspect/--layout/--cursor are supported; URLs/accounts are pinned to the isolated fixture");
  await fs.mkdir(OUT, { recursive: true });
  const modulePath = process.env.PW_MODULE || DEFAULT_PW;
  if (path.basename(await fs.realpath(modulePath)) !== "playwright") throw new Error("PW_MODULE must resolve to the Playwright package");
  const { chromium } = require(modulePath);
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const timeout = setTimeout(() => { void browser.close(); }, 240000);
  timeout.unref();
  try {
    const ready = await newContext("ready");
    await login(ready.page, "ready");
    const page = ready.page;
    if (args.includes("--cursor")) {
      await verifyDirectionalCursor(page);
      await ready.context.close();
      return;
    }
    if (args.includes("--layout")) {
      await verifyWelcomeLayout(page);
      await check("onboarding-character-finishes-lazy-load", async () => {
        const setup = await newContext("setup-layout"); activePage = setup.page;
        try {
          await login(setup.page, "setup");
          await setup.page.waitForFunction(() => (document.querySelector('.tp-ai-character defs > path[id^="ch-head-"]')?.getAttribute("d") || "").length > 100);
          assert.equal(await setup.page.locator(".tp-ai-character").count(), 1);
          assert.equal(await setup.page.locator(".tp-ai-character-placeholder").count(), 0);
          await screenshot(setup.page, "08-onboarding-loaded");
          return { characterCount: 1, renderedSvg: true, noPersonaSaved: true };
        } finally { await setup.context.close(); activePage = page; }
      });
      await ready.context.close();
      return;
    }
    await check("welcome-load-and-single-character", async () => {
      await page.waitForFunction(() => (document.querySelector('.tp-ai-chat .tp-ai-character defs > path[id^="ch-head-"]')?.getAttribute("d") || "").length > 100);
      assert.equal(await page.locator(".tp-ai-character").count(), 1);
      assert.equal(await page.locator(".tp-ai-chat canvas, .tp-ai-orb, .tp-ai-visual-toggle, .tp-ai-motion-toggle").count(), 0);
      assert.equal(await page.locator("vite-error-overlay, [data-nextjs-dialog]").count(), 0);
      assert.equal(await page.locator("#tp-ai-message-input").count(), 1);
      const shape = await characterSnapshot(page);
      assert.ok(shape.svg && shape.head.length > 100);
      await screenshot(page, "01-welcome");
      return { characterCount: 1, legacyVisualSelectorsAbsent: true, shape: { width: shape.width, height: shape.height, viewBox: shape.viewBox } };
    });
    if (args.includes("--inspect")) {
      console.log(JSON.stringify({ buttons: await page.getByRole("button").allTextContents(), text: (await page.locator("body").innerText()).slice(0, 1800) }));
      return;
    }
    await verifyDirectionalCursor(page);
    await check("pointer-updates-geometry-without-container-follow", async () => {
      await page.mouse.move(30, 400); await page.waitForTimeout(400);
      const left = await characterSnapshot(page);
      await page.mouse.move(1390, 400); await page.waitForTimeout(400);
      const right = await characterSnapshot(page);
      assert.ok(left.head !== right.head || left.eyes !== right.eyes);
      for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(left[key] - right[key]) < 0.5, `${key} moved with pointer`);
      return { fixedContainer: { x: left.x, y: left.y, width: left.width, height: left.height }, leftGeometry: hash(left.head + left.eyes), rightGeometry: hash(right.head + right.eyes), note: "Animated pose also changes naturally; pointer behavior is paired with source/unit coverage, not inferred solely from differing frames." };
    });
    await check("animation-at-most-30fps", async () => {
      const counts = await countFrames(page);
      assert.ok(counts.frames > 2);
      assert.ok(counts.frames <= Math.ceil(counts.milliseconds / 1000 * 30) + 1, JSON.stringify(counts));
      return counts;
    });
    await check("reduced-motion-draws-static-and-pauses", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" }); await page.waitForTimeout(150);
      const counts = await countFrames(page, 600);
      assert.equal(counts.frames, 0);
      assert.ok((await characterSnapshot(page)).head.length > 100);
      await page.emulateMedia({ reducedMotion: "no-preference" }); await page.waitForTimeout(150);
      assert.ok((await countFrames(page, 500)).frames > 1);
      return counts;
    });
    await check("hidden-document-pauses-and-resumes", async () => {
      await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
      const hidden = await countFrames(page, 600); assert.equal(hidden.frames, 0);
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
      const visible = await countFrames(page, 500); assert.ok(visible.frames > 1);
      return { hidden, visible, method: "Controlled document.hidden getter and visibilitychange in this isolated context only" };
    });
    await check("all-14-expressions-render-save-and-survive-reload", async () => {
      const outcomes = [];
      for (const [index, expression] of EXPRESSIONS.entries()) {
        await openSettings(page);
        const buttons = page.locator(".tp-ai-expression-grid button");
        assert.equal(await buttons.count(), 14);
        await buttons.nth(index).click(); await page.waitForTimeout(180);
        assert.equal(await buttons.nth(index).getAttribute("aria-pressed"), "true");
        const visual = await characterSnapshot(page, ".tp-ai-persona-dialog .tp-ai-character");
        if (expression === "auto" || expression === "none") assert.equal(Number(visual.glyphOpacity), 0);
        else { assert.ok(visual.glyph.length > 20, `${expression} missing glyph`); assert.ok(Number(visual.glyphOpacity) > 0, `${expression} hidden glyph`); }
        const savedResponse = page.waitForResponse(r => r.url().endsWith("/api/ai/persona") && r.request().method() === "PUT");
        await page.getByRole("button", { name: "保存记忆", exact: true }).click();
        const response = await savedResponse; assert.equal(response.status(), 200);
        const saved = await response.json(); assert.equal(saved.profile.expression, expression);
        await page.getByRole("dialog", { name: "我的专属 AI", exact: true }).waitFor({ state: "hidden" });
        await page.reload({ waitUntil: "domcontentloaded" });
        await enterAi(page);
        await page.locator("#tp-ai-message-input").waitFor();
        await openSettings(page);
        assert.equal(await page.locator(".tp-ai-expression-grid button").nth(index).getAttribute("aria-pressed"), "true");
        outcomes.push({ expression, immediateGlyphHash: hash(visual.glyph), opacity: visual.glyphOpacity, savedAndReloaded: true });
        if (expression === "smitten") {
          await page.locator(".tp-ai-expression-picker").scrollIntoViewIfNeeded();
          await page.waitForTimeout(180);
          await screenshot(page, "02-expression-settings");
        }
        await page.getByRole("button", { name: "关闭专属 AI 设置", exact: true }).click();
        console.log(JSON.stringify({ expression, savedAndReloaded: true }));
      }
      assert.equal(new Set(outcomes.filter(o => !["auto", "none"].includes(o.expression)).map(o => o.immediateGlyphHash)).size, 12);
      // Return the disposable ready account to its default visual preference.
      await openSettings(page); await page.locator(".tp-ai-expression-grid button").first().click();
      await page.getByRole("button", { name: "保存记忆", exact: true }).click();
      await page.getByRole("dialog", { name: "我的专属 AI", exact: true }).waitFor({ state: "hidden" });
      return outcomes;
    });
    await check("quota-summary-percent-only-and-detail-units", async () => {
      const account = page.getByRole("button", { name: /个人账户，查看使用详情/ });
      await account.hover();
      await page.locator("#tp-ai-quota-summary").waitFor({ state: "visible" });
      await page.waitForTimeout(180);
      const summary = await page.locator("#tp-ai-quota-summary").innerText();
      assert.match(summary, /\d+%/); assert.doesNotMatch(summary, /Token|同频点|100,?000/);
      await account.click();
      const details = page.getByRole("dialog", { name: "使用详情", exact: true });
      await details.waitFor();
      const text = await details.innerText();
      assert.match(text, /同频点/); assert.match(text, /输入 Token/); assert.match(text, /输出 Token/);
      await screenshot(page, "03-usage-details");
      await page.getByRole("button", { name: "关闭使用详情", exact: true }).click();
      return { summary, detailHasTokenAndPoints: true };
    });
    await check("long-history-initially-mounts-40-messages", async () => {
      const isolated = await newContext("long"); activePage = isolated.page;
      try {
        await login(isolated.page, "long");
        const count = await isolated.page.locator(".tp-ai-messages article").count();
        assert.equal(count, 40);
        assert.equal(await isolated.page.locator(".tp-ai-character").count(), 1);
        const earlier = isolated.page.getByRole("button", { name: "加载更早的消息（还有 120 条）", exact: true });
        assert.equal(await earlier.count(), 1);
        await screenshot(isolated.page, "04-long-history");
        await earlier.click(); assert.equal(await isolated.page.locator(".tp-ai-messages article").count(), 80);
        return { initialMessages: count, afterExplicitLoad: 80, totalFixtureMessages: 160 };
      } finally { await isolated.context.close(); activePage = page; }
    });
    await check("boss-has-own-ai-and-percent-summary", async () => {
      const isolated = await newContext("boss"); activePage = isolated.page;
      try {
        await login(isolated.page, "boss");
        assert.equal(await isolated.page.locator(".tp-ai-character").count(), 1);
        assert.equal(await isolated.page.locator("#tp-ai-message-input").count(), 1);
        await isolated.page.getByRole("button", { name: /个人账户，查看使用详情/ }).hover();
        await isolated.page.locator("#tp-ai-quota-summary").waitFor({ state: "visible" });
        await isolated.page.waitForTimeout(180);
        const summary = await isolated.page.locator("#tp-ai-quota-summary").innerText();
        assert.match(summary, /100%/); assert.doesNotMatch(summary, /Token|同频点|10,?000/);
        return { summary, ownWorkspaceAvailable: true };
      } finally { await isolated.context.close(); activePage = page; }
    });
    await check("onboarding-shows-one-character", async () => {
      const isolated = await newContext("setup"); activePage = isolated.page;
      try {
        await login(isolated.page, "setup");
        await isolated.page.getByRole("dialog", { name: "认识你的专属 AI", exact: true }).waitFor();
        assert.equal(await isolated.page.locator(".tp-ai-character").count(), 1);
        await screenshot(isolated.page, "05-onboarding");
        return { characterCount: 1, noPersonaSaved: true };
      } finally { await isolated.context.close(); activePage = page; }
    });
    await check("character-chunk-failure-is-local-not-chat-failure", async () => {
      const isolated = await newContext("chunk-failure", true); activePage = isolated.page;
      try {
        await login(isolated.page, "ready");
        await isolated.page.locator(".tp-ai-character-placeholder").waitFor();
        await isolated.page.waitForTimeout(350);
        assert.equal(await isolated.page.locator(".tp-ai-chat").count(), 1);
        const input = isolated.page.locator("#tp-ai-message-input");
        assert.equal(await input.isEnabled(), true);
        await input.fill("仅验证组件异常后输入可用，不发送。");
        assert.equal(await input.inputValue(), "仅验证组件异常后输入可用，不发送。");
        assert.equal(await isolated.page.getByRole("button", { name: "发送消息", exact: true }).isEnabled(), true);
        assert.equal(await isolated.page.locator(".tp-ai-character-placeholder").count(), 1);
        assert.equal(await isolated.page.locator("vite-error-overlay").count(), 0);
        await screenshot(isolated.page, "06-local-character-fallback");
        await input.fill("");
        return { decorativeFallbackCount: 1, chatUsable: true, messageNotSent: true };
      } finally { await isolated.context.close(); activePage = page; }
    });
    await check("no-unexpected-browser-errors", async () => {
      const unexpected = report.errors.filter(e => !e.expectedChunkFailure);
      assert.equal(unexpected.length, 0, JSON.stringify(unexpected).slice(0, 1500));
      return { pageErrors: report.errors.filter(e => e.kind === "pageerror").length, expectedChunkErrors: report.errors.filter(e => e.expectedChunkFailure).length };
    });
    await ready.context.close();
  } finally { clearTimeout(timeout); await browser.close(); }
}

main().catch(error => {
  report.fatal = String(error.message).slice(0, 1200);
  console.error(JSON.stringify({ fatal: report.fatal }));
}).finally(async () => {
  await browser?.close().catch(() => {});
  report.completedAt = new Date().toISOString();
  report.passed = !report.fatal && report.checks.every(c => c.passed);
  await fs.mkdir(OUT, { recursive: true });
  const output = path.join(OUT, process.argv.includes("--inspect") ? "inspection.json" : process.argv.includes("--layout") ? "welcome-layout-verification.json" : process.argv.includes("--cursor") ? "directional-cursor-verification.json" : "browser-character-verification.json");
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  if (process.argv.includes("--cursor") && report.passed) {
    const character = JSON.parse(await fs.readFile(path.join(OUT, "browser-character-verification.json"), "utf8"));
    const layout = JSON.parse(await fs.readFile(path.join(OUT, "welcome-layout-verification.json"), "utf8"));
    const checks = [
      ...character.checks.filter(c => c.name !== "native-ai-cursor-and-text-cursor").map(c => ({ ...c, verifiedAt: character.completedAt })),
      ...layout.checks.map(c => ({ ...c, verifiedAt: layout.completedAt })),
      ...report.checks.map(c => ({ ...c, verifiedAt: report.completedAt })),
    ];
    const final = {
      version: "0.1.37", assembledAt: new Date().toISOString(), passed: checks.every(c => c.passed) && !layout.fatal && !report.fatal,
      scope: "Isolated loopback fixture; no production account, paid messages, deployment, or user browser/profile accessed",
      checks, supersededChecks: [{ name: "native-ai-cursor-and-text-cursor", reason: "User requested restored directional arrow after initial character QA; replaced by dedicated directional cursor checks." }],
      corrections: ["Initial checks adapted to legitimate view reset after reload and animated navigation; these were harness assumptions, not feature failures.", "Cold onboarding screenshot initially captured lazy placeholder; dedicated followup verifies actual rendered SVG.", "Welcome fixed-expression SVG track overflow was an actual visual issue, fixed by CSS track/min-size constraints and spacing; six expression/viewport combinations pass.", "720px sidebar is a drawer and was closed normally before inspecting chat; no forced click or CSS override used."],
      sourceReports: [path.join(OUT, "browser-character-verification.json"), path.join(OUT, "welcome-layout-verification.json"), output],
      screenshots: [...character.screenshots.filter(p => !p.endsWith("05-onboarding.png")), ...layout.screenshots, ...report.screenshots],
      errors: [...character.errors, ...layout.errors, ...report.errors],
    };
    await fs.writeFile(path.join(OUT, "browser-character-final.json"), JSON.stringify(final, null, 2) + "\n", { mode: 0o600 });
  }
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: output }));
  process.exitCode = report.passed ? 0 : 1;
});
