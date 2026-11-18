/**
 * boot-dl.js — 下载页引导（固定不变）
 * 按 version.json 的版本号依次加载 remux.js（TS→MP4 重封装）和 hls.js，
 * 改动这两个文件后刷新本页即生效，无需重载扩展。
 */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(src));
    document.body.appendChild(s);
  });
}

(async () => {
  let version = "0";
  try {
    const res = await fetch(chrome.runtime.getURL("version.json") + "?t=" + Date.now(), { cache: "no-store" });
    const j = await res.json();
    if (j && typeof j.version === "string") version = j.version;
  } catch (e) {
    /* 忽略 */
  }

  const v = "?v=" + encodeURIComponent(version);

  // 重封装模块失败不致命：hls.js 会退回原始 .ts
  try {
    await loadScript(chrome.runtime.getURL("remux.js") + v);
  } catch (e) {
    /* 忽略 */
  }

  try {
    await loadScript(chrome.runtime.getURL("hls.js") + v);
  } catch (e) {
    const p = document.createElement("p");
    p.className = "err";
    p.textContent = "脚本加载失败：请确认 hls.js 存在于扩展目录中。";
    document.querySelector(".card")?.appendChild(p);
  }
})();
