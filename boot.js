/**
 * boot.js — 弹窗引导（固定不变）
 *
 * 读磁盘上的 version.json，然后按版本号加载 ui.css / ui.js。
 * 因为 URL 带 ?v=<版本>，改动 ui.js 后重新打开弹窗就是最新代码，
 * 不需要去 chrome://extensions 重载扩展。
 */

(async () => {
  let version = "0";
  try {
    const res = await fetch(chrome.runtime.getURL("version.json") + "?t=" + Date.now(), { cache: "no-store" });
    const j = await res.json();
    if (j && typeof j.version === "string") version = j.version;
  } catch (e) {
    /* 读不到就用 0，页面仍加载 ui.js 的当前磁盘版本 */
  }

  window.__VS_VERSION = version;

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = chrome.runtime.getURL("ui.css") + "?v=" + encodeURIComponent(version);
  document.head.appendChild(css);

  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("ui.js") + "?v=" + encodeURIComponent(version);
  s.onerror = () => {
    const box = document.createElement("div");
    box.id = "boot-error";
    box.textContent = "界面脚本加载失败：请确认 ui.js 存在于扩展目录中。";
    document.body.appendChild(box);
  };
  document.body.appendChild(s);
})();
