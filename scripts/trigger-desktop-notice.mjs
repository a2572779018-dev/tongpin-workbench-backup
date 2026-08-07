import WebSocket from "ws";

const port = Number(process.env.TONGPIN_CDP_PORT || 9231);
const mode = process.argv[2] || "show";
const response = await fetch(`http://127.0.0.1:${port}/json`);
if (!response.ok) {
  throw new Error(`无法连接 Electron 调试端口 ${port}`);
}

const targets = await response.json();
const mainWindowModes = new Set([
  "show",
  "inapp",
  "inapp-hover",
  "watch-updater",
  "read-updater",
  "read-updater-latest",
]);
const page = targets.find(
  (target) =>
    target.type === "page" &&
    typeof target.webSocketDebuggerUrl === "string" &&
    (mainWindowModes.has(mode)
      ? !String(target.url).includes("notice.html")
      : String(target.url).includes("notice.html")),
);
if (!page) {
  throw new Error(
    mode === "show" ? "没有找到同频主窗口" : "没有找到同频通知窗口",
  );
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

const requestId = 1;
const expression =
  mode === "show"
    ? `window.tongpin.notify({
        title: "老板发来新通知",
        body: "请在今天下班前同步当前任务进展。"
      })`
    : mode === "inapp"
      ? `window.dispatchEvent(new CustomEvent("tongpin:notice", {
          detail: {
            id: "packaged-preview",
            title: "更新已准备好",
            body: "同频 0.1.3 已下载完成。安装前请保存正在编辑的任务。",
            tone: "update"
          }
        }))`
      : mode === "inapp-hover"
        ? `(() => {
            const notice = document.querySelector(".notice-center");
            if (!notice) return false;
            notice.dispatchEvent(new PointerEvent("pointerover", {
              bubbles: true,
              pointerType: "mouse"
            }));
            return true;
          })()`
      : mode === "watch-updater"
        ? `(() => {
            window.__tongpinUpdaterEvents = [];
            window.__stopTongpinUpdaterWatch?.();
            window.__stopTongpinUpdaterWatch = window.tongpin.onUpdaterStatus(
              (status) => window.__tongpinUpdaterEvents.push(status)
            );
            return true;
          })()`
        : mode === "read-updater-latest"
          ? `(() => {
              const events = window.__tongpinUpdaterEvents || [];
              return {
                count: events.length,
                last: events.at(-1) || null,
                recent: events.slice(-5),
              };
            })()`
        : mode === "read-updater"
          ? `window.__tongpinUpdaterEvents || []`
          : mode === "read-notice"
            ? `(() => {
                const notice = document.getElementById("notice");
                return {
                  title: document.getElementById("title")?.textContent || "",
                  body: document.getElementById("body")?.textContent || "",
                  expanded: notice?.classList.contains("is-expanded") || false,
                  tone: notice?.dataset.tone || "",
                };
              })()`
            : `document.getElementById("notice").dispatchEvent(
                new MouseEvent("${mode === "collapse" ? "mouseleave" : "mouseenter"}")
              )`;
socket.send(
  JSON.stringify({
    id: requestId,
    method: "Runtime.evaluate",
    params: {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
  }),
);

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("触发桌面通知超时")),
    10_000,
  );
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id !== requestId) return;
    clearTimeout(timer);
    resolve(message);
  });
  socket.once("error", reject);
});
socket.close();

if (result.error || result.result?.exceptionDetails) {
  throw new Error(
    JSON.stringify(result.error || result.result.exceptionDetails),
  );
}

console.log(
  JSON.stringify({
    mode,
    triggered: result.result?.result?.value === true,
    value: result.result?.result?.value,
    target: page.title,
  }),
);
