const { _electron } = require(process.env.PW_MODULE);
const { writeFileSync } = require("node:fs");

async function main() {
  const app = await _electron.launch({
    executablePath: process.env.TONGPIN_PACKAGED_EXE,
    args: [`--user-data-dir=${process.env.TONGPIN_PACKAGED_PROFILE}`],
  });

  try {
    const page = await app.firstWindow();
    await page.waitForTimeout(2_500);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addStyleTag({
      content: "* { animation: none !important; transition: none !important; }",
    });
    const result = await page.evaluate(() => ({
      title: document.title,
      heading:
        document.querySelector("h1, h2")?.textContent?.trim() ?? "",
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      bodyLength: document.body.innerText.length,
    }));
    const browserWindow = await app.browserWindow(page);
    const screenshot = await browserWindow.evaluate(async (window) =>
      (await window.webContents.capturePage()).toPNG().toString("base64"),
    );
    writeFileSync(
      process.env.TONGPIN_PACKAGED_SCREENSHOT,
      Buffer.from(screenshot, "base64"),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
