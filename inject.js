/**
 * inject.js — 运行在页面主世界
 *
 * 两件事：
 *  1. 识别受保护内容（EME / MSE encrypted），只上报布尔信号，不做任何解密
 *  2. 补齐「只探测到一个视频」的漏网情况：
 *     - hook fetch / XHR，抓播放器动态请求的播放列表（URL 常常没有 .m3u8 后缀）
 *     - 抓到播放列表正文后上报，后台据此累积分片（滑窗/事件流只保留最近几片，
 *       累积后才能还原完整时长）
 *     - 扫 performance resource timing，补回扩展注入前就已加载的媒体地址
 */

(function () {
  if (window.__vsInjected) return;
  window.__vsInjected = true;

  const post = (sig, data) => {
    try {
      window.postMessage(Object.assign({ __vs: 1, sig }, data || {}), "*");
    } catch (e) {
      /* ignore */
    }
  };

  const reportDrm = () => post("drm");

  /* ---------------- DRM 识别 ---------------- */

  try {
    const orig = navigator.requestMediaKeySystemAccess;
    if (typeof orig === "function") {
      navigator.requestMediaKeySystemAccess = function (keySystem, configs) {
        reportDrm();
        return orig.call(navigator, keySystem, configs);
      };
    }
  } catch (e) {
    /* ignore */
  }

  try {
    if (window.MediaSource && MediaSource.prototype.addSourceBuffer) {
      const origAdd = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (mime) {
        if (typeof mime === "string" && /encrypted/i.test(mime)) reportDrm();
        window.__vsMseUsed = true;
        return origAdd.call(this, mime);
      };
    }
  } catch (e) {
    /* ignore */
  }

  try {
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, "keySystem");
    if (desc && desc.get) {
      Object.defineProperty(Navigator.prototype, "keySystem", {
        configurable: true,
        get() {
          reportDrm();
          return desc.get.call(this);
        }
      });
    }
  } catch (e) {
    /* ignore */
  }

  /* ---------------- 媒体地址识别 ---------------- */

  const MEDIA_RE = /\.(m3u8|mpd|mp4|m4v|webm|flv|mkv|mov|ts|m4s)(\?|#|$)/i;
  const MAX_TEXT = 400 * 1024;

  /** 页面里大量使用相对地址（fetch('/api/play?...')），必须先补成绝对地址 */
  const toAbs = (u) => {
    if (!u) return "";
    try {
      return new URL(String(u), location.href).href;
    } catch (e) {
      return "";
    }
  };

  const isHttp = (u) => /^https?:/i.test(u || "");
  const isMediaUrl = (u) => isHttp(u) && MEDIA_RE.test(u);
  const isPlaylistText = (t) =>
    typeof t === "string" && t.length > 6 && t.slice(0, 400).indexOf("#EXTM3U") !== -1;

  const sent = new Set();
  function sendMedia(rawUrl, via) {
    const url = toAbs(rawUrl);
    if (!isHttp(url) || !isMediaUrl(url)) return;
    const key = "m:" + url;
    if (sent.has(key)) return;
    sent.add(key);
    if (sent.size > 4000) sent.clear();
    post("media", { url, via });
  }

  /** 同一播放列表会反复请求（滑窗刷新），正文变了就要重新上报 */
  function sendPlaylist(rawUrl, text, ct) {
    const url = toAbs(rawUrl);
    if (!isHttp(url) || !isPlaylistText(text)) return;
    const key = "p:" + url + "|" + text.length + "|" + text.slice(-120);
    if (sent.has(key)) return;
    sent.add(key);
    if (sent.size > 4000) sent.clear();
    post("playlist", { url, text: text.slice(0, MAX_TEXT), ct: ct || "" });
  }

  // 有些站把播放列表伪装成 text/plain、json、octet-stream，地址也没有后缀，
  // 只能靠「地址关键词 + 正文是否以 #EXTM3U 开头」认出来。
  const API_HINT = /(play|m3u8|mpd|video|media|stream|manifest|master|index|live|vod|episode|drama|movie)/i;
  function sniffCandidate(url, ct) {
    const c = ct || "";
    if (/mpegurl|dash\+xml/i.test(c)) return true;
    if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) return true;
    if (API_HINT.test(url) && /^(text\/|application\/(octet-stream|json|javascript|x-javascript))/i.test(c)) return true;
    return false;
  }

  /* ---------------- fetch hook ---------------- */

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, init) {
        let url = "";
        try {
          url = toAbs(typeof input === "string" ? input : input && input.url ? input.url : String(input || ""));
        } catch (e) {
          url = "";
        }
        const p = origFetch.apply(this, arguments);
        if (!isHttp(url)) return p;

        p.then((res) => {
          try {
            if (!res || !res.ok) return;
            const finalUrl = res.url || url;
            const ct = (res.headers && res.headers.get("content-type")) || "";
            const looksPl =
              /mpegurl|dash\+xml/i.test(ct) || /\.m3u8(\?|#|$)/i.test(finalUrl) || /\.mpd(\?|#|$)/i.test(finalUrl);

            if (!looksPl && (isMediaUrl(finalUrl) || /^(video|audio)\//i.test(ct))) {
              sendMedia(finalUrl, "fetch");
            } else if (looksPl || sniffCandidate(finalUrl, ct)) {
              res
                .clone()
                .text()
                .then((t) => {
                  if (isPlaylistText(t)) sendPlaylist(finalUrl, t, ct);
                  else if (isMediaUrl(finalUrl)) sendMedia(finalUrl, "fetch");
                })
                .catch(() => {});
            }
          } catch (e) {
            /* ignore */
          }
        }).catch(() => {});

        return p;
      };
    }
  } catch (e) {
    /* ignore */
  }

  /* ---------------- XHR hook ---------------- */

  try {
    const XP = XMLHttpRequest.prototype;
    const origOpen = XP.open;
    const origSend = XP.send;

    XP.open = function (method, url) {
      try {
        this.__vsUrl = url;
      } catch (e) {
        /* ignore */
      }
      return origOpen.apply(this, arguments);
    };

    XP.send = function () {
      try {
        this.addEventListener("load", () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            const url2 = toAbs(this.responseURL || this.__vsUrl || "");
            if (!isHttp(url2)) return;
            const ct = this.getResponseHeader("content-type") || "";
            const looksPl =
              /mpegurl|dash\+xml/i.test(ct) || /\.m3u8(\?|#|$)/i.test(url2) || /\.mpd(\?|#|$)/i.test(url2);

            if (looksPl || sniffCandidate(url2, ct)) {
              let text = "";
              try {
                if (!this.responseType || this.responseType === "text") text = this.responseText;
              } catch (e) {
                text = "";
              }
              if (isPlaylistText(text)) sendPlaylist(url2, text, ct);
              else if (isMediaUrl(url2)) sendMedia(url2, "xhr");
            } else if (isMediaUrl(url2) || /^(video|audio)\//i.test(ct)) {
              sendMedia(url2, "xhr");
            }
          } catch (e) {
            /* ignore */
          }
        });
      } catch (e) {
        /* ignore */
      }
      return origSend.apply(this, arguments);
    };
  } catch (e) {
    /* ignore */
  }

  /* ---------------- resource timing 兜底 ---------------- */

  let lastScan = 0;
  function scanPerf(force) {
    const now = Date.now();
    if (!force && now - lastScan < 1500) return;
    lastScan = now;
    try {
      const list = performance.getEntriesByType("resource");
      for (let i = 0; i < list.length; i++) sendMedia(list[i].name, "perf");
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 上报播放器真实状态：
   *  1. duration / buffered / seekable —— 判断「页面到底有没有拿到完整视频」的唯一可靠依据
   *     （duration 大而 buffered 只有前 15 秒 = 页面也只缓冲了开头；
   *       duration 本身就只有 15 秒 = 服务端只下发了 15 秒）
   *  2. paused / 可见面积 / 是否有声 —— 判断「一堆探测结果里哪个是此刻正在看的那个」
   *     （正在播的元素一定未暂停、在视口里、面积最大；广告位和预加载的往往是隐藏的）
   */
  let lastStateHash = "";
  function reportStateInner(force) {
    let nodes;
    try {
      nodes = document.querySelectorAll("video, audio");
    } catch (e) {
      return;
    }
    if (!nodes.length) return;

    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;

    const items = [];
    let idx = 0;
    for (const el of nodes) {
      const dur = Number(el.duration);
      const rangeOf = (r) => {
        const out = [];
        try {
          for (let i = 0; i < r.length && i < 12; i++) {
            out.push([Math.round((r.start(i) || 0) * 10) / 10, Math.round((r.end(i) || 0) * 10) / 10]);
          }
        } catch (e) {
          /* ignore */
        }
        return out;
      };
      let src = "";
      try {
        src = el.currentSrc || el.getAttribute("src") || "";
      } catch (e) {
        src = "";
      }

      // 可见面积：元素在视口里真正占多少像素，用来识别「页面的主画面」
      let area = 0;
      let vis = false;
      try {
        const r = el.getBoundingClientRect();
        const iw = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const ih = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        area = Math.round(iw * ih);
        vis = area > 4096;
      } catch (e) {
        /* ignore */
      }

      items.push({
        idx: idx++,
        dur: isFinite(dur) && dur > 0 ? Math.round(dur * 10) / 10 : 0,
        cur: Math.round((el.currentTime || 0) * 10) / 10,
        buf: rangeOf(el.buffered),
        seek: rangeOf(el.seekable),
        rs: el.readyState || 0,
        mse: /^blob:/i.test(src),
        src: /^https?:/i.test(src) ? src : "",
        w: el.videoWidth || 0,
        h: el.videoHeight || 0,
        paused: !!el.paused,
        ended: !!el.ended,
        loud: !el.muted && (el.volume || 0) > 0,
        vis,
        area
      });
    }

    // 面积最大的可见视频 = 页面主画面（弹窗用它来对账「列表时长 vs 播放器时长」）
    let topIdx = -1;
    let topArea = 0;
    for (const it of items) {
      if (it.vis && it.area > topArea) {
        topArea = it.area;
        topIdx = it.idx;
      }
    }
    for (const it of items) it.main = it.idx === topIdx;

    // 哈希按「秒」取整：timeupdate 每 250ms 触发一次，按 0.1s 算会疯狂上报
    const hash =
      items
        .map(
          (it) =>
            `${it.idx}|${it.dur}|${Math.floor(it.cur)}|${it.buf.length}|${it.paused ? 1 : 0}|${
              it.vis ? 1 : 0
            }|${it.w}x${it.h}|${it.main ? 1 : 0}`
        )
        .join(";") + (window.__vsMseUsed ? "|mse" : "");
    if (hash === lastStateHash && !force) return;
    lastStateHash = hash;
    post("state", { items, mse: !!window.__vsMseUsed });
  }

  /** 页面里的元素随时可能被框架销毁，读属性抛错不能变成「扩展错误」 */
  function reportState(force) {
    try {
      reportStateInner(force);
    } catch (e) {
      /* ignore */
    }
  }

  function scanMediaElements() {
    let nodes;
    try {
      nodes = document.querySelectorAll("video, audio");
    } catch (e) {
      return;
    }
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!el) continue;
      try {
        const src = el.currentSrc || el.getAttribute("src") || "";
        if (src) sendMedia(src, "dom");
      } catch (e) {
        /* ignore */
      }
      // 有些播放器把地址挂在 data 属性上
      try {
        const attrs = el.attributes || [];
        for (let k = 0; k < attrs.length; k++) {
          const a = attrs[k];
          if (a && a.name.lastIndexOf("data-", 0) === 0 && /^https?:\/\//i.test(a.value || "")) {
            sendMedia(a.value, "dom");
          }
        }
      } catch (e) {
        /* ignore */
      }
    }
  }

  try {
    const HME = HTMLMediaElement.prototype;
    const origPlay = HME.play;
    if (typeof origPlay === "function") {
      HME.play = function () {
        setTimeout(() => {
          scanPerf(true);
          scanMediaElements();
          reportState();
        }, 300);
        setTimeout(() => {
          scanPerf(true);
          scanMediaElements();
          reportState();
        }, 2000);
        return origPlay.apply(this, arguments);
      };
    }
  } catch (e) {
    /* ignore */
  }

  // 播放中时长/缓冲会持续变化，靠事件驱动上报，不额外加定时器
  try {
    document.addEventListener("durationchange", reportState, true);
    document.addEventListener("loadedmetadata", reportState, true);
    document.addEventListener("progress", reportState, true);
    document.addEventListener("timeupdate", reportState, true);
    document.addEventListener("ended", reportState, true);
  } catch (e) {
    /* ignore */
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { scanPerf(true); scanMediaElements(); reportState(); }, { once: true });
  } else {
    scanPerf(true);
    scanMediaElements();
    reportState();
  }
  window.addEventListener("load", () => { scanPerf(true); scanMediaElements(); reportState(); }, { once: true });

  // 后台 SW 会休眠，休眠后 pageStates 丢失；定期强制补报一次，让弹窗随时都能对上账
  let lastForced = 0;
  setInterval(() => {
    scanPerf(false);
    scanMediaElements();
    const force = Date.now() - lastForced > 15000;
    if (force) lastForced = Date.now();
    reportState(force);
  }, 3000);
  setInterval(() => scanPerf(true), 12000);
})();
