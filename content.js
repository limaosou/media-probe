/**
 * content.js — 内容脚本
 *
 * 1. 把 inject.js 注入到页面主世界（检测 DRM、抓播放器动态请求的播放列表）
 * 2. 转发页面上报的信号给 background
 * 3. 扫描 DOM 中 <video>/<source> 的直链，并统计页面视频元素数量
 *
 * 注意：扩展被重载/更新后，已经打开的页面里的这份脚本会立刻失去运行时
 * （Extension context invalidated），此时任何 chrome.* 调用都会抛异常，
 * 而 MutationObserver 还会不停触发，于是 chrome://extensions 里就刷出一堆红字。
 * 所以所有后台通信统一走 send()，一旦发现上下文失效就彻底把自己关掉。
 */

(function () {
  let dead = false;

  function alive() {
    if (dead) return false;
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) {
        dead = true;
        return false;
      }
    } catch (e) {
      dead = true;
      return false;
    }
    return true;
  }

  function send(type, payload) {
    if (!alive()) return;
    try {
      const p = chrome.runtime.sendMessage(Object.assign({ type }, payload || {}));
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      // Extension context invalidated —— 之后不再尝试
      dead = true;
    }
  }

  // ---- 1. 注入主世界脚本 ----
  // manifest 里已用 world:"MAIN" 在 document_start 直接加载 inject.js（更早、不受 CSP 影响），
  // 这里只在旧版浏览器不支持 world 字段时兜底。
  try {
    if (!window.__vsInjected && alive()) {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("inject.js");
      s.async = false;
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    }
  } catch (e) {
    /* 某些 CSP 严格的页面会失败，忽略 */
  }

  // ---- 2. 接收主世界信号 ----
  window.addEventListener("message", (ev) => {
    try {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.__vs !== 1) return;

      if (d.sig === "drm") {
        send("drmDetected");
        return;
      }
      if (d.sig === "playlist" && d.url && d.text) {
        send("pagePlaylist", { url: d.url, text: d.text, ct: d.ct || "" });
        return;
      }
      if (d.sig === "media" && d.url) {
        send("pageMedia", { url: d.url, via: d.via || "hook" });
        return;
      }
      if (d.sig === "state" && Array.isArray(d.items)) {
        send("pageState", { items: d.items, mse: !!d.mse });
      }
    } catch (e) {
      /* 页面把 message event 改坏时不要影响扩展 */
    }
  });

  // ---- 3. 兜底扫描 DOM 直链 ----
  const MEDIA_RE = /\.(m3u8|mpd|mp4|m4v|webm|flv|mkv|mov|ts|m4s)(\?|#|$)/i;
  const seen = new Set();

  function scan() {
    if (!alive()) return;
    let nodes;
    try {
      nodes = document.querySelectorAll("video, video source, audio, audio source");
    } catch (e) {
      return;
    }

    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!el) continue;

      const candidates = [];
      try {
        if (el.currentSrc) candidates.push(el.currentSrc);
      } catch (e) {
        /* ignore */
      }
      try {
        const attr = typeof el.getAttribute === "function" ? el.getAttribute("src") : "";
        if (attr) candidates.push(attr);
      } catch (e) {
        /* ignore */
      }
      // 有些播放器把地址挂在 data-* 上（只收媒体后缀，避免把埋点地址当视频）
      try {
        const attrs = el.attributes || [];
        for (let k = 0; k < attrs.length; k++) {
          const a = attrs[k];
          if (a && /^data-/.test(a.name) && MEDIA_RE.test(String(a.value || ""))) candidates.push(a.value);
        }
      } catch (e) {
        /* ignore */
      }

      for (let j = 0; j < candidates.length; j++) {
        const raw = candidates[j];
        if (typeof raw !== "string" || !raw) continue;
        if (raw.lastIndexOf("blob:", 0) === 0 || raw.lastIndexOf("data:", 0) === 0) continue;

        let abs = raw;
        try {
          abs = new URL(raw, location.href).href;
        } catch (e) {
          abs = raw;
        }
        if (typeof abs !== "string" || !/^https?:/i.test(abs)) continue;
        if (seen.has(abs)) continue;
        if (seen.size > 800) seen.clear();
        seen.add(abs);
        send("pageMedia", { url: abs, via: "dom" });
      }
    }
  }

  /** 告诉后台这页一共几个视频元素，用来提示「还有几个没探测到」 */
  let lastCount = -1;
  function reportCount() {
    if (!alive()) return;
    let n = 0;
    try {
      n = document.querySelectorAll("video").length;
    } catch (e) {
      return;
    }
    if (n === lastCount) return;
    lastCount = n;
    send("pageInfo", { videoCount: n });
  }

  let timer = null;
  function scheduleScan() {
    if (dead) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        scan();
        reportCount();
      } catch (e) {
        /* 扫描永远不该把异常冒到扩展错误面板 */
      }
    }, 600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleScan, { once: true });
  } else {
    scheduleScan();
  }

  let observer = null;
  try {
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {
    /* ignore */
  }

  // 不要用定时器频繁上报：MV3 的 Service Worker 会被反复唤醒。改为事件驱动。
  document.addEventListener("click", reportCount, { passive: true, once: true });
  document.addEventListener("visibilitychange", reportCount, { passive: true });

  // 扩展重载后主动收摊：每分钟探一次活，失效就断开观察器，不再产生任何错误
  const guard = setInterval(() => {
    if (alive()) return;
    clearInterval(guard);
    if (timer) clearTimeout(timer);
    try {
      if (observer) observer.disconnect();
    } catch (e) {
      /* ignore */
    }
  }, 60000);
})();
