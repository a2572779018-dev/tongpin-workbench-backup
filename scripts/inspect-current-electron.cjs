const { chromium } = require(process.env.PW_MODULE);

async function main() {
  const browser = await chromium.connectOverCDP(
    process.env.TONGPIN_CDP_URL ?? "http://127.0.0.1:9229",
  );
  const context = browser.contexts()[0];
  const page = context?.pages()[0];
  if (!page) throw new Error("No Electron renderer page found");

  const events = [];
  page.on("pageerror", (error) => {
    events.push({ type: "pageerror", message: error.message, stack: error.stack });
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      events.push({ type: "console", message: message.text() });
    }
  });
  page.on("requestfailed", (request) => {
    events.push({
      type: "requestfailed",
      message: `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`,
    });
  });

  await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForTimeout(4_000);
  const state = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    bodyText: document.body.innerText.slice(0, 2_000),
    rootHtml: document.querySelector("#root")?.innerHTML.slice(0, 4_000) ?? "",
    bodyBackground: getComputedStyle(document.body).backgroundColor,
  }));

  process.stdout.write(`${JSON.stringify({ state, events }, null, 2)}\n`);
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
