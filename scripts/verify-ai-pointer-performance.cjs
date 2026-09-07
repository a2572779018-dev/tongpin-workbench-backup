/** Loopback-only, isolated Chrome performance QA. No persona or chat writes. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const OUT = "/Users/sam/Documents/ChatGPT/个人/tongpin-release-downloads/qa-0.1.38";
const UI = "http://127.0.0.1:5174";
const PW = "/Users/sam/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
const report = { version: "0.1.38-candidate", startedAt: new Date().toISOString(), origin: UI, isolatedHeadlessChrome: true, personaWrites: 0, chatRequests: 0, blockedRequests: [], errors: [], checks: [], scenarios: [] };
let browser;
let page;
async function sourceDigests() {
  const files = ["src/components/CustomCursor.tsx", "src/features/tongpin-ai/visuals/fleur/FleurCharacter.tsx", "src/features/tongpin-ai/visuals/fleur/character-runtime.js", "src/features/tongpin-ai/visuals/fleur/pointerFollow.ts", "src/features/tongpin-ai/visuals/fleur/visibleFrameLoop.ts"];
  return Object.fromEntries(await Promise.all(files.map(async file => [file, crypto.createHash("sha256").update(await fs.readFile(path.join(__dirname, "..", file))).digest("hex")])));
}
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : null; };
const intervals = rows => rows.slice(1).map((row, i) => row.t - rows[i].t);
const stats = values => ({ count: values.length, median: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99), max: values.length ? Math.max(...values) : null });

async function record(name, run) {
  try { const details = await run(); report.checks.push({ name, passed: true, details }); console.log(JSON.stringify({ stage: name, passed: true })); return details; }
  catch (error) { report.checks.push({ name, passed: false, error: String(error.message).slice(0, 1500) }); console.log(JSON.stringify({ stage: name, passed: false, error: String(error.message).slice(0, 500) })); return null; }
}

async function enterAi() {
  const nav = page.getByRole("button", { name: "同频 AI", exact: true });
  await nav.focus(); await nav.press("Enter");
  await page.locator("#tp-ai-message-input").waitFor();
  await page.waitForFunction(() => (document.querySelector('.tp-ai-chat .tp-ai-character defs > path[id^="ch-head-"]')?.getAttribute("d") || "").length > 100);
}

async function collectTrace(durationMs) {
  return page.evaluate(duration => new Promise(resolve => {
    const cursor = document.querySelector(".custom-cursor");
    const target = document.querySelector(".tp-ai-chat");
    const head = target.querySelector('defs > path[id^="ch-head-"]');
    const inputs = [], paints = [], characterPaints = [], longTasks = [], idleWrites = [];
    let current = null, firstRaf = null, phase = "moving", seq = 0;
    const cursorPoint = () => {
      const matrix = new DOMMatrix(cursor.style.transform);
      return { x: matrix.m41 + 10, y: matrix.m42 };
    };
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.target !== cursor) continue;
        const point = cursorPoint();
        const row = { t: performance.now(), latestInput: current?.seq ?? -1, x: point.x, y: point.y, matchesLatest: Boolean(current && Math.abs(point.x - current.x) < .01 && Math.abs(point.y - current.y) < .01) };
        (phase === "idle" ? idleWrites : paints).push(row);
      }
    });
    observer.observe(cursor, { attributes: true, attributeFilter: ["style"] });
    const characterObserver = new MutationObserver(records => { for (const record of records) if (record.attributeName === "d") characterPaints.push({ t: performance.now() }); });
    characterObserver.observe(head, { attributes: true, attributeFilter: ["d"] });
    let longTaskObserver;
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      longTaskObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push({ t: entry.startTime, duration: entry.duration }); });
      longTaskObserver.observe({ type: "longtask" });
    }
    function tick(t) {
      firstRaf ??= t;
      if (t - firstRaf >= duration) {
        // Paint scheduled by the final input may already have run; drain two
        // real RAFs before testing the idle interval, without fake timer clocks.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          phase = "idle";
          setTimeout(() => {
            observer.disconnect(); characterObserver.disconnect(); longTaskObserver?.disconnect();
            resolve({ durationRequestedMs: duration, inputs, paints, characterPaints, longTasks, idleWrites, idleWindowMs: 600 });
          }, 600);
        }));
        return;
      }
      const before = cursorPoint();
      const previous = current;
      current = { seq: seq++, t, dispatchAt: performance.now(), x: 400 + ((seq * 7) % 700), y: 205 + ((seq % 9) * 4) };
      inputs.push({ ...current, cursorBefore: before, previousInputPainted: !previous || (Math.abs(before.x - previous.x) < .01 && Math.abs(before.y - previous.y) < .01) });
      // One synthetic mouse PointerEvent per genuine RAF. No timers simulate
      // browser cadence; this is not a physical trackpad or OS input-latency test.
      target.dispatchEvent(new PointerEvent("pointermove", { clientX: current.x, clientY: current.y, pointerType: "mouse", bubbles: true }));
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }), durationMs);
}

async function runScenario(cdp, cpuRate, characterMotion) {
  const name = `cursor-${characterMotion ? "active" : "static"}-cpu${cpuRate}`;
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  await page.emulateMedia({ reducedMotion: characterMotion ? "no-preference" : "reduce" });
  await page.mouse.move(450, 220); await page.waitForTimeout(300);
  const trace = await collectTrace(4500);
  const frameIntervals = intervals(trace.inputs), paintIntervals = intervals(trace.paints);
  const medianRaf = percentile(frameIntervals, .5);
  const summary = {
    name, cpuRate, characterMotion,
    actualMovingMs: trace.inputs.at(-1).t - trace.inputs[0].t,
    inputRafs: trace.inputs.length, cursorPaints: trace.paints.length,
    inputFps: frameIntervals.length / ((trace.inputs.at(-1).t - trace.inputs[0].t) / 1000),
    paintFps: paintIntervals.length / ((trace.paints.at(-1).t - trace.paints[0].t) / 1000),
    paintsPerInput: trace.paints.length / trace.inputs.length,
    staleCoordinates: trace.paints.filter(row => !row.matchesLatest).length,
    framesWithoutPreviousInputPaint: trace.inputs.slice(1).filter(row => !row.previousInputPainted).length,
    paintGapsAbove1Point5Raf: paintIntervals.filter(ms => ms > medianRaf * 1.5).length,
    inputGapsAbove1Point5Raf: frameIntervals.filter(ms => ms > medianRaf * 1.5).length,
    rafIntervalMs: stats(frameIntervals), paintIntervalMs: stats(paintIntervals),
    dispatchToStyleWriteMs: stats(trace.paints.map(row => row.t - trace.inputs[row.latestInput].dispatchAt)),
    characterPaints: trace.characterPaints.length,
    characterFps: trace.characterPaints.length > 1 ? (trace.characterPaints.length - 1) / ((trace.characterPaints.at(-1).t - trace.characterPaints[0].t) / 1000) : 0,
    characterPaintIntervalMs: stats(intervals(trace.characterPaints)),
    idleStyleWrites: trace.idleWrites.length, longTasks: trace.longTasks,
  };
  const traceFile = path.join(OUT, `${name}-timeseries.json`);
  await fs.writeFile(traceFile, JSON.stringify({ ...summary, trace }, null, 2) + "\n", { mode: 0o600 });
  report.scenarios.push({ ...summary, traceFile });
  await record(name, async () => {
    assert.ok(summary.paintsPerInput >= .98 && summary.paintsPerInput <= 1.01, JSON.stringify(summary));
    assert.equal(summary.staleCoordinates, 0);
    assert.equal(summary.framesWithoutPreviousInputPaint, 0);
    assert.equal(summary.idleStyleWrites, 0);
    if (!characterMotion) assert.equal(summary.characterPaints, 0);
    else assert.ok(summary.characterPaints > 10);
    return summary;
  });
  console.log(JSON.stringify({ scenario: name, inputFps: summary.inputFps, paintFps: summary.paintFps, paintsPerInput: summary.paintsPerInput, rafP95: summary.rafIntervalMs.p95, paintP95: summary.paintIntervalMs.p95, stale: summary.staleCoordinates, frameSkips: summary.framesWithoutPreviousInputPaint }));
}

async function main() {
  assert.equal(process.argv.length, 2, "No configurable production URLs/accounts are accepted");
  report.sourceDigestsAtStart = await sourceDigests();
  await fs.mkdir(OUT, { recursive: true });
  const modulePath = process.env.PW_MODULE || PW;
  assert.equal(path.basename(await fs.realpath(modulePath)), "playwright");
  const { chromium } = require(modulePath);
  browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (!["127.0.0.1:5174", "127.0.0.1:4319"].includes(url.host) || (!["GET", "HEAD"].includes(request.method()) && !(request.method() === "POST" && url.pathname === "/api/auth/login"))) {
      report.blockedRequests.push({ method: request.method(), host: url.host, pathname: url.pathname }); await route.abort("blockedbyclient"); return;
    }
    await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", error => report.errors.push({ kind: "pageerror", text: error.message.slice(0, 800) }));
  page.on("console", message => { if (message.type() === "error") report.errors.push({ kind: "console", text: message.text().slice(0, 800) }); });
  const timeout = setTimeout(() => void browser.close(), 180000); timeout.unref();
  try {
    await page.goto(UI, { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "邮箱", exact: true }).fill("ready@tongpin.test");
    await page.locator('input[type="password"]').fill("Fixture123!");
    await page.getByRole("button", { name: "登录同频", exact: true }).click();
    await enterAi();
    await record("page-ready", async () => {
      assert.equal(await page.locator(".custom-cursor").count(), 1);
      assert.equal(await page.locator(".tp-ai-chat .tp-ai-character").count(), 1);
      assert.equal(await page.locator("vite-error-overlay, [data-nextjs-dialog]").count(), 0);
      return { bodyNotBlank: (await page.locator("body").innerText()).trim().length > 0, cursorCount: 1, characterCount: 1 };
    });
    const cdp = await context.newCDPSession(page);
    for (const [cpuRate, motion] of [[1, true], [1, false], [4, true], [4, false]]) await runScenario(cdp, cpuRate, motion);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.screenshot({ path: path.join(OUT, "pointer-performance-page.png") });
    await record("no-unexpected-browser-errors-or-writes", async () => {
      assert.deepEqual(report.errors, []); assert.deepEqual(report.blockedRequests, []);
      return { pageErrors: 0, blockedWrites: 0, personaWrites: 0, paidChatRequests: 0 };
    });
  } finally { clearTimeout(timeout); await context.close(); await browser.close(); }
}

main().catch(error => { report.fatal = String(error.message).slice(0, 1800); console.error(JSON.stringify({ fatal: report.fatal })); }).finally(async () => {
  await browser?.close().catch(() => {});
  report.sourceDigestsAtEnd = await sourceDigests();
  report.sourceUnchangedDuringMeasurement = JSON.stringify(report.sourceDigestsAtStart) === JSON.stringify(report.sourceDigestsAtEnd);
  report.completedAt = new Date().toISOString(); report.passed = !report.fatal && report.checks.every(c => c.passed);
  report.passed = report.passed && report.sourceUnchangedDuringMeasurement;
  report.measurementBoundary = "Real headless Chrome RAF cadence with one synthetic mouse event per RAF. CSS attribute-write times are measured, not OS input latency or compositor presentation. CPU 4x is DevTools throttling, not a physical slow Windows machine. Unit behavior does not establish subjective smoothness.";
  await fs.mkdir(OUT, { recursive: true });
  const output = path.join(OUT, "pointer-performance-summary.json");
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, report: output })); process.exitCode = report.passed ? 0 : 1;
});
