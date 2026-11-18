/**
 * background.js — 稳定壳（很少需要改动）
 *
 * 职责：
 *  1. 用 webRequest 观察页面媒体请求，按 tabId 归档到内存 + storage.session（SW 休眠不丢）
 *  2. 嗅探判定完全由 rules.json 驱动 —— 改规则即时生效，无需重载扩展
 *  3. 版本检测：磁盘 version.json 与已应用版本不一致时，在图标上提示
 *
 * 热更新分层：
 *  - rules.json / ui.js / ui.css / hls.js → 加载时带 ?v=<版本>，改动立即生效
 *  - 本文件属于 Service Worker 骨架，改动需要重载扩展（弹窗提供「应用」按钮）
 */

const DEFAULT_RULES = {
  version: "0",
  hlsExts: ["m3u8"],
  dashExts: ["mpd"],
  fileExts: ["mp4", "m4v", "webm", "flv", "mkv", "mov", "ts", "m4s", "mp3", "m4a", "aac", "ogg", "opus"],
  splitExts: ["ts", "m4s"],
  imageExts: ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "svg"],
  contentTypes: {
    hls: ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl"],
    dash: ["application/dash+xml"],
    file: ["video/", "audio/"],
    image: ["image/"]
  },
  ignorePatterns: ["doubleclick.net", "googlesyndication", "/ads/", "/advert"],
  imageIgnorePatterns: ["/favicon", "favicon.ico", "sprite", "/pixel", "1x1.", "spacer.gif", "/blank."],
  minBytes: 0,
  minImageBytes: 5120,
  maxPerTab: 500,
  hideSegmentsByDefault: true
};

const OBSERVE_TYPES = ["media", "xmlhttprequest", "other", "object", "image"];
const SESSION_KEY = "vs_streams";
const META_KEY = "vs_meta";
const PL_KEY = "vs_playlists";

let rules = DEFAULT_RULES;
let rulesAt = 0;
let uiVersion = null;
let swVersion = null;
let appliedSw = null;

/** @type {Map<number, Map<string, object>>} */
const tabs = new Map();
const drmTabs = new Set();
const pageMeta = new Map();

/**
 * 页面侧（inject.js）抓到的播放列表快照，按 tab 归档。
 * 关键作用：很多站的播放列表是「滑动窗口」，每次只保留最近几片（15 秒），
 * 把历次请求的正文按分片累积起来，才能还原完整时长。
 * @type {Map<number, Map<string, object>>}
 */
const playlists = new Map();
/** @type {Map<number, Map<number, number>>} tabId -> frameId -> 该 frame 的 <video> 数量 */
const frameVideos = new Map();

/**
 * 页面播放器自报的真实状态（inject.js 上报）：
 * duration / buffered / seekable。用来判断「页面到底有没有拿到完整视频」——
 * 这是区分「我们没抓到」和「服务端只给了试看」的唯一客观依据。
 * 同时也是判断「哪条结果是此刻正在播的那个」的关键：未暂停 + 可见 + 面积最大。
 * @type {Map<number, {items: object[], mse: boolean, at: number}>}
 */
const pageStates = new Map();
/**
 * 按 frame 分开存：很多站的播放器在 iframe 里，各 frame 都会上报 state，
 * 若只按 tabId 存会互相覆盖。这里保留分 frame 的原始数据，再聚合成 pageStates。
 * @type {Map<number, Map<number, {items: object[], mse: boolean, at: number}>>}
 */
const stateFrames = new Map();

/**
 * 网络侧的字节范围信息：http 206 + Content-Range 说明是整文件分段拉取。
 * @type {Map<number, Map<string, {total: number, parts: Set<string>, ct: string, status: number}>>}
 */
const netRanges = new Map();

let dirty = false;
let flushTimer = null;

/* ---------------- 热更新：规则 ---------------- */

async function loadRules(force = false) {
  if (!force && Date.now() - rulesAt < 15000) return rules;
  try {
    const res = await fetch(chrome.runtime.getURL("rules.json") + "?t=" + Date.now(), { cache: "no-store" });
    const j = await res.json();
    rules = { ...DEFAULT_RULES, ...j };
    rulesAt = Date.now();
  } catch (e) {
    /* 规则文件损坏时沿用上一版，不影响功能 */
  }
  return rules;
}

async function readDiskVersion() {
  try {
    const res = await fetch(chrome.runtime.getURL("version.json") + "?t=" + Date.now(), { cache: "no-store" });
    const j = await res.json();
    return {
      ui: typeof j.version === "string" ? j.version : null,
      sw: typeof j.sw === "string" ? j.sw : typeof j.version === "string" ? j.version : null
    };
  } catch {
    return { ui: null, sw: null };
  }
}

async function checkVersion(force = false) {
  const now = Date.now();
  if (!force && now - (checkVersion.at || 0) < 20000) return;
  checkVersion.at = now;

  const v = await readDiskVersion();
  if (!v.ui && !v.sw) return;
  uiVersion = v.ui;
  swVersion = v.sw;

  const st = await chrome.storage.local.get(["appliedSw"]);
  if (!st.appliedSw) {
    appliedSw = swVersion;
    await chrome.storage.local.set({ appliedSw: swVersion });
  } else {
    appliedSw = st.appliedSw;
  }
  await chrome.storage.local.set({
    diskVersion: uiVersion,
    diskSw: swVersion,
    pendingVersion: swVersion !== appliedSw ? swVersion : ""
  });

  for (const tabId of tabs.keys()) updateBadge(tabId);
}

/* ---------------- 会话持久化（SW 休眠后列表不丢） ---------------- */

async function restoreSession() {
  try {
    const st = await chrome.storage.session.get([SESSION_KEY, META_KEY, PL_KEY]);
    for (const [tabId, arr] of Object.entries(st[SESSION_KEY] || {})) {
      const m = new Map();
      for (const rec of arr) m.set(rec.url, rec);
      tabs.set(Number(tabId), m);
    }
    for (const [tabId, meta] of Object.entries(st[META_KEY] || {})) {
      pageMeta.set(Number(tabId), meta);
    }
    for (const [tabId, list] of Object.entries(st[PL_KEY] || {})) {
      const m = new Map();
      for (const pl of list || []) if (pl && pl.url) m.set(plKey(pl.url), pl);
      if (m.size) playlists.set(Number(tabId), m);
    }
  } catch {
    /* storage.session 不可用时降级为纯内存 */
  }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 1200);
}

async function flush() {
  flushTimer = null;
  if (!dirty) return;
  dirty = false;
  const out = {};
  for (const [tabId, m] of tabs) out[tabId] = [...m.values()];
  const meta = {};
  for (const [tabId, v] of pageMeta) meta[tabId] = v;
  const pls = {};
  for (const [tabId, m] of playlists) {
    const arr = [];
    for (const pl of m.values()) {
      arr.push({
        url: pl.url,
        segments: pl.segments,
        init: pl.init || null,
        duration: pl.duration,
        ended: pl.ended,
        drm: pl.drm,
        master: pl.master,
        ct: pl.ct,
        updated: pl.updated
      });
      if (arr.length >= 20) break;
    }
    if (arr.length) pls[tabId] = arr;
  }
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: out, [META_KEY]: meta, [PL_KEY]: pls });
  } catch {
    /* 配额或不可用，忽略 */
  }
}

const ready = (async () => {
  await restoreSession();
  await loadRules(true);
  await checkVersion(true);
})();

/* ---------------- 判定（规则驱动） ---------------- */

function isIgnored(url) {
  const u = url.toLowerCase();
  return (rules.ignorePatterns || []).some((p) => u.includes(String(p).toLowerCase()));
}

/**
 * @param {string} url
 * @param {string} [ct]
 * @returns {"hls"|"dash"|"file"|"seg"|null}
 */
/**
 * 图片的专属忽略名单：站点图标、雪碧图、1×1 埋点像素这类东西不该出现在列表里。
 * 单独一套，避免把视频的 /ads/ 之类规则拿过来误伤。
 */
function isImageIgnored(url) {
  const s = String(url || "").toLowerCase();
  const list = rules.imageIgnorePatterns || [];
  for (let i = 0; i < list.length; i++) {
    if (s.includes(String(list[i]).toLowerCase())) return true;
  }
  return false;
}

function kindOf(url, ct = "") {
  if (!url || isIgnored(url)) return null;
  const path = url.split(/[?#]/)[0].toLowerCase();
  const ext = path.includes(".") ? path.split(".").pop() : "";
  const c = (ct || "").toLowerCase();

  if ((rules.hlsExts || []).includes(ext)) return "hls";
  if ((rules.contentTypes.hls || []).some((m) => c.includes(m))) return "hls";
  if ((rules.dashExts || []).includes(ext)) return "dash";
  if ((rules.contentTypes.dash || []).some((m) => c.includes(m))) return "dash";
  if ((rules.fileExts || []).includes(ext)) {
    return (rules.splitExts || []).includes(ext) ? "seg" : "file";
  }
  if ((rules.contentTypes.file || []).some((m) => c.startsWith(m))) return "file";

  // 图片放在最后判：先让视频/音频规则优先，避免 image/ 之外的 MIME 被误吞
  const isImg =
    (rules.imageExts || []).includes(ext) ||
    (rules.contentTypes.image || []).some((m) => c.startsWith(m));
  if (isImg) return isImageIgnored(url) ? null : "img";
  return null;
}

function headerValue(info, name) {
  const list = info.responseHeaders || info.requestHeaders || [];
  const hit = list.find((h) => h.name.toLowerCase() === name);
  return hit ? hit.value || "" : "";
}

/* ---------------- 图片：DOM 侧补全（尺寸 + 是否在视口内） ---------------- */

/**
 * 网络层只能告诉我们「这个地址被请求过」，拿不到「这张图多大、现在看不看得见」。
 * 图片列表要能一眼分辨，就靠这里注入页面扫一遍 <img>：
 *  - currentSrc / src / srcset 里最大的那个 / data-*（懒加载未触发时地址藏在 data 里）
 *  - naturalWidth/Height 用来显示尺寸，也用来过滤 1×1 埋点
 *  - getBoundingClientRect 判断是否真的在视口内（用户此刻看得到的图）
 *
 * 注意：这个函数会被序列化后注入页面执行，不能引用任何外部变量。
 */
function collectImagesFunc() {
  const out = [];
  const seen = new Set();
  const abs = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch (e) {
      return "";
    }
  };
  const bestFromSrcset = (ss) => {
    if (!ss) return "";
    let best = "";
    let bestW = -1;
    const parts = String(ss).split(",");
    for (let i = 0; i < parts.length; i++) {
      const bits = parts[i].trim().split(/\s+/);
      const u = bits[0];
      if (!u) continue;
      const d = bits[1] || "";
      let w = 0;
      if (/^\d+w$/.test(d)) w = parseInt(d, 10);
      else if (/^\d+(\.\d+)?x$/.test(d)) w = parseFloat(d) * 1000;
      if (w > bestW) {
        bestW = w;
        best = u;
      }
    }
    return best;
  };

  const vh = window.innerHeight || 800;
  const vw = window.innerWidth || 1200;
  const imgs = document.images || [];
  for (let i = 0; i < imgs.length && out.length < 300; i++) {
    const el = imgs[i];
    let url = "";
    try {
      url = el.currentSrc || el.getAttribute("src") || "";
    } catch (e) {
      url = "";
    }
    if (!url) {
      try {
        url = bestFromSrcset(el.getAttribute("srcset"));
      } catch (e) {
        /* ignore */
      }
    }
    if (!url) {
      const attrs = ["data-src", "data-original", "data-lazy-src", "data-url", "data-image"];
      for (let k = 0; k < attrs.length; k++) {
        try {
          const v = el.getAttribute(attrs[k]);
          if (v) {
            url = v;
            break;
          }
        } catch (e) {
          /* ignore */
        }
      }
    }
    if (!url) continue;
    url = abs(url);
    if (!/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);

    let vis = 0;
    try {
      const r = el.getBoundingClientRect();
      vis = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw ? 1 : 0;
    } catch (e) {
      vis = 0;
    }
    out.push({ u: url, w: el.naturalWidth || 0, h: el.naturalHeight || 0, v: vis });
  }
  return out;
}

/** 扫一遍页面上所有框架的 <img>，把尺寸/可见性合进归档 */
async function scanTabImages(tabId) {
  let out;
  try {
    out = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: collectImagesFunc
    });
  } catch (e) {
    return 0;
  }
  let n = 0;
  for (const r of out || []) {
    const arr = Array.isArray(r && r.result) ? r.result : [];
    for (const it of arr) {
      if (!it || !it.u || isImageIgnored(it.u)) continue;
      // DOM 扫描拿不到字节数，改用面积判：小于 64×64 的基本都是图标 / 埋点像素
      if ((it.w && it.w <= 2) || (it.h && it.h <= 2)) continue;
      if (it.w && it.h && it.w * it.h < 4096) continue;
      upsert(tabId, it.u, { kind: "img", src: "dom", w: it.w || 0, h: it.h || 0, vis: !!it.v });
      n++;
    }
  }
  return n;
}

/* ---------------- 播放列表快照（分片累积） ---------------- */

function absUrl(u, base) {
  try {
    return new URL(u, base).href;
  } catch {
    return u;
  }
}

/**
 * 播放列表的稳定标识：很多站点每次刷新都会给同一个列表换上新的时间戳/签名参数，
 * 若按原始 URL 归档，滑动窗口的历次快照就会分裂成几十条，无法累积。
 */
const VOLATILE_PARAMS = /^(t|_t|ts|_|time|timestamp|nonce|rand|random|sign|signature|token|expires|expire|auth|auth_key|key|_sign|_ts)$/i;

function plKey(url) {
  try {
    const u = new URL(url);
    const keep = [];
    for (const [k, v] of u.searchParams) if (!VOLATILE_PARAMS.test(k)) keep.push([k, v]);
    keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const qs = keep.map(([k, v]) => `${k}=${v}`).join("&");
    return u.origin + u.pathname + (qs ? "?" + qs : "");
  } catch {
    return url;
  }
}

/**
 * 极简 m3u8 解析：只要分片地址、时长、序号与 AES-128 密钥信息。
 * 不做任何解密，仅在下载页里用于还原完整分片序列。
 */
function parseM3u8(text, base) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const res = { master: false, variants: [], segments: [], init: null, duration: 0, ended: false, drm: false };
  let dur = 0;
  let key = null;
  let seq = 0;
  let brNext = null;
  let lastBr = null;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    if (l.startsWith("#EXT-X-STREAM-INF")) {
      const bw = /BANDWIDTH=(\d+)/.exec(l);
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith("#")) j++;
      if (j < lines.length) {
        res.master = true;
        res.variants.push({ url: absUrl(lines[j], base), bandwidth: parseInt((bw && bw[1]) || "0", 10) || 0 });
      }
      i = j;
      continue;
    }

    if (l.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      seq = parseInt(l.split(":")[1], 10) || 0;
      continue;
    }

    if (l === "#EXT-X-ENDLIST") {
      res.ended = true;
      continue;
    }

    if (l.startsWith("#EXT-X-MAP:")) {
      const u = /URI="([^"]*)"/i.exec(l);
      if (u) res.init = { url: absUrl(u[1], base), k: key };
      continue;
    }

    if (l.startsWith("#EXT-X-KEY:")) {
      const m = /METHOD=([^,]+)/i.exec(l);
      const method = m ? m[1].trim().toUpperCase() : "";
      if (!method || method === "NONE") {
        key = null;
        continue;
      }
      if (method !== "AES-128") {
        res.drm = true;
        key = null;
        continue;
      }
      const u = /URI="([^"]*)"/i.exec(l);
      const iv = /IV=([^,]+)/i.exec(l);
      key = { uri: u ? absUrl(u[1], base) : "", iv: iv ? iv[1].trim() : "" };
      continue;
    }

    if (l.startsWith("#EXT-X-BYTERANGE:")) {
      // 分片共用同一个文件、只靠字节区间区分 —— 按 URL 去重会把整段视频折叠成 1 片
      const [lenS, offS] = l.slice(17).trim().split("@");
      const len = parseInt(lenS, 10) || 0;
      const off = offS != null ? parseInt(offS, 10) || 0 : lastBr ? lastBr.off + lastBr.len : 0;
      brNext = { len, off };
      continue;
    }

    if (l.startsWith("#EXTINF:")) {
      dur = parseFloat(l.slice(8)) || 0;
      continue;
    }

    if (l.startsWith("#")) continue;

    const seg = { u: absUrl(l, base), d: dur, k: key, s: seq + res.segments.length };
    if (brNext) {
      seg.br = [brNext.off, brNext.len];
      lastBr = brNext;
      brNext = null;
    }
    res.segments.push(seg);
    res.duration += dur;
    dur = 0;
  }

  return res;
}

/** 分片身份：同一个文件的不同字节区间必须视为不同分片 */
function segId(s) {
  return s.br ? `${s.u}#${s.br[0]}-${s.br[1]}` : s.u;
}

/** 合并两次快照：取并集并保持播放顺序（滑窗场景下这就是「补全时长」的关键） */
function mergeSegments(prev, next) {
  if (!prev || !prev.segments || !prev.segments.length) return next;
  if (!next.segments.length) return prev;

  const prevUrls = prev.segments.map(segId);
  const prevSet = new Set(prevUrls);
  const nextSet = new Set(next.segments.map(segId));

  if (prevUrls.every((u) => nextSet.has(u))) return next; // 新列表更全（正片列表加载完成）
  const missing = next.segments.filter((s) => !prevSet.has(segId(s)));
  if (!missing.length) return prev; // 新列表已全部包含在旧列表里

  const segments = prev.segments.concat(missing);
  return Object.assign({}, prev, {
    segments,
    duration: segments.reduce((a, s) => a + (s.d || 0), 0),
    ended: prev.ended || next.ended,
    drm: prev.drm || next.drm,
    master: prev.master || next.master,
    init: next.init || prev.init
  });
}

function storePlaylist(tabId, url, text, ct) {
  if (tabId == null || tabId < 0 || !url) return;
  if (!text || String(text).indexOf("#EXTM3U") === -1) return;

  let m = playlists.get(tabId);
  if (!m) {
    m = new Map();
    playlists.set(tabId, m);
  }

  const next = parseM3u8(text, url);
  const key = plKey(url);
  const prev = m.get(key);
  const merged = mergeSegments(prev, next);

  merged.url = url;
  merged.ct = ct || (prev && prev.ct) || "";
  merged.updated = Date.now();
  if (merged.segments.length > 4000) merged.segments = merged.segments.slice(-4000);

  m.set(key, merged);

  // 有些站的播放列表 URL 没有 .m3u8 后缀，靠正文才认出来 —— 这里补记为 HLS 条目
  upsert(tabId, url, { kind: "hls", ct: merged.ct, src: "hook" });
}

function playlistOf(tabId, url) {
  const key = plKey(url);
  const local = playlists.get(tabId);
  if (local) {
    if (local.has(key)) return local.get(key);
    if (local.has(url)) return local.get(url);
  }
  for (const m of playlists.values()) {
    if (m.has(key)) return m.get(key);
    if (m.has(url)) return m.get(url);
  }
  return null;
}

function storeOf(tabId) {
  let m = tabs.get(tabId);
  if (!m) {
    m = new Map();
    tabs.set(tabId, m);
  }
  return m;
}

function upsert(tabId, url, patch) {
  if (tabId == null || tabId < 0) return;
  if (!url || url.startsWith("blob:") || url.startsWith("data:")) return;

  const m = storeOf(tabId);
  let rec = m.get(url);
  if (!rec) {
    rec = { url, kind: null, size: 0, ct: "", referer: "", src: "net", first: Date.now(), last: Date.now(), hits: 0 };
    m.set(url, rec);
    const max = rules.maxPerTab || 400;
    if (m.size > max) {
      let oldestKey = null;
      let oldestTs = Infinity;
      for (const [k, v] of m) if (v.last < oldestTs) { oldestTs = v.last; oldestKey = k; }
      if (oldestKey) m.delete(oldestKey);
    }
  }
  Object.assign(rec, patch);
  rec.last = Date.now();
  rec.hits = (rec.hits || 0) + 1;

  scheduleFlush();
  updateBadge(tabId);
}

function updateBadge(tabId) {
  const m = tabs.get(tabId);
  const visible = m
    ? [...m.values()].filter((r) => !(rules.hideSegmentsByDefault && r.kind === "seg")).length
    : 0;
  const pending = swVersion && appliedSw && swVersion !== appliedSw;
  const text = pending ? "↑" + (visible || "") : visible ? String(visible) : "";
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action
    .setBadgeBackgroundColor({
      tabId,
      color: pending ? "#e8710a" : drmTabs.has(tabId) ? "#b3261e" : "#1a73e8"
    })
    .catch(() => {});
}

function clearTab(tabId) {
  tabs.delete(tabId);
  drmTabs.delete(tabId);
  playlists.delete(tabId);
  frameVideos.delete(tabId);
  pageStates.delete(tabId);
  stateFrames.delete(tabId);
  netRanges.delete(tabId);
  scheduleFlush();
  updateBadge(tabId);
}

/* ---------------- 网络观察（必须顶层同步注册） ---------------- */

chrome.webRequest.onBeforeRequest.addListener(
  (info) => {
    if (info.tabId < 0) return;
    // 图片常常没有后缀（/api/img/1234），光看 URL 认不出来，用浏览器给的资源类型兜底
    const imgType = info.type === "image";
    if (!imgType && !kindOf(info.url)) return;
    ready.then(() => {
      let kind = kindOf(info.url);
      if (!kind && imgType && !isIgnored(info.url) && !isImageIgnored(info.url)) kind = "img";
      if (kind) upsert(info.tabId, info.url, { kind });
    });
  },
  { urls: ["<all_urls>"], types: OBSERVE_TYPES }
);

chrome.webRequest.onHeadersReceived.addListener(
  (info) => {
    if (info.tabId < 0) return;
    const ct = headerValue(info, "content-type");
    const len = parseInt(headerValue(info, "content-length") || "0", 10) || 0;

    // 记录字节区间：206 + Content-Range 说明页面在「整文件分段拉取」
    const cr = headerValue(info, "content-range");
    if (cr || info.statusCode === 206) {
      try {
        let m = netRanges.get(info.tabId);
        if (!m) {
          m = new Map();
          netRanges.set(info.tabId, m);
        }
        let e = m.get(info.url);
        if (!e) {
          e = { total: 0, parts: new Set(), ct: ct || "", status: info.statusCode || 0 };
          m.set(info.url, e);
        }
        const pm = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(cr || "");
        if (pm) {
          e.parts.add(`${pm[1]}-${pm[2]}`);
          if (pm[3] !== "*") e.total = parseInt(pm[3], 10) || 0;
        } else if (cr) {
          e.parts.add(cr.slice(0, 40));
        }
        e.status = info.statusCode || e.status;
        if (ct) e.ct = ct;
        if (m.size > 200) m.delete(m.keys().next().value);
      } catch {
        /* 忽略 */
      }
    }

    ready.then(() => {
      let kind = kindOf(info.url, ct);
      if (!kind && info.type === "image" && !isIgnored(info.url) && !isImageIgnored(info.url)) kind = "img";
      if (!kind) return;
      // 图片单独一套体积门槛：站点图标、1×1 埋点像素默认不进列表
      const minB = kind === "img" ? rules.minImageBytes || 0 : rules.minBytes || 0;
      if (len && len < minB) return;
      upsert(info.tabId, info.url, { kind, ct, size: len });
    });
  },
  { urls: ["<all_urls>"], types: OBSERVE_TYPES },
  ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onSendHeaders.addListener(
  (info) => {
    if (info.tabId < 0) return;
    ready.then(() => {
      const rec = tabs.get(info.tabId)?.get(info.url);
      if (!rec) return;
      const ref = headerValue(info, "referer") || headerValue(info, "origin");
      if (ref && ref !== rec.referer) {
        rec.referer = ref;
        scheduleFlush();
      }
    });
  },
  { urls: ["<all_urls>"], types: OBSERVE_TYPES },
  ["requestHeaders", "extraHeaders"]
);

/* ---------------- 标签页事件 ---------------- */

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" && change.url) {
    clearTab(tabId);
    pageMeta.set(tabId, { url: change.url, title: "" });
    // 每次导航都重新读一次规则：改完 rules.json 后，新页面立即按新规则嗅探
    ready.then(() => loadRules(true));
  } else if (change.title) {
    const meta = pageMeta.get(tabId) || { url: "", title: "" };
    meta.title = change.title;
    pageMeta.set(tabId, meta);
  }
  scheduleFlush();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  drmTabs.delete(tabId);
  pageMeta.delete(tabId);
  playlists.delete(tabId);
  frameVideos.delete(tabId);
  pageStates.delete(tabId);
  stateFrames.delete(tabId);
  netRanges.delete(tabId);
  relayFrames.delete(tabId);
  scheduleFlush();
});

/* ---------------- 转发取流：让页面用自己的身份去取 ---------------- */

/**
 * 有些 CDN 只认「页面自身」发出的请求：它校验 Referer / Origin / Cookie / Sec-Fetch-Site，
 * 发现请求来自 chrome-extension:// 就回 403 或 520。
 *
 * 这时候伪造请求头没用（sec-* 系列头根本不允许改），正确做法是**真的回到那个页面里**，
 * 用页面自己的身份发一次请求 —— 页面能播，就一定能取到。
 *
 * 用 scripting.executeScript 而不是给内容脚本发消息，是因为：
 * ① 扩展重载后旧页面里的 content script 已经失效，注入则是每次都新鲜的；
 * ② 可以直接指定 frameId，多 iframe 的站点也能精确落到能取到流的那个框架里。
 *
 * @type {Map<number, {ids: number[]}>} tabId -> 该页所有框架（已按成功率排序）
 */
const relayFrames = new Map();

/** 注意：这个函数会被序列化后注入页面，不能引用外部变量 */
function pageFetchFunc(url, range, asText) {
  return (async () => {
    try {
      const init = { credentials: "include", cache: "no-store" };
      if (range && range.length === 2 && range[1] > 0) {
        init.headers = { Range: "bytes=" + range[0] + "-" + (range[0] + range[1] - 1) };
      }
      const res = await fetch(url, init);
      if (!res.ok) return { ok: false, status: res.status, error: "HTTP " + res.status };
      const ct = res.headers.get("content-type") || "";
      if (asText) return { ok: true, status: res.status, ct: ct, text: await res.text() };
      const buf = new Uint8Array(await res.arrayBuffer());
      let bin = "";
      const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      }
      return { ok: true, status: res.status, ct: ct, b64: btoa(bin), len: buf.length };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  })();
}

/** 列出标签页里的所有框架（按「最可能是播放页」排序：主框架在前） */
async function relayTargets(tabId) {
  let st = relayFrames.get(tabId);
  if (st) return st;
  let out;
  try {
    out = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({ href: location.href })
    });
  } catch (e) {
    return null;
  }
  if (!out || !out.length) return null;
  const ids = out
    .map((r) => r.frameId)
    .sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b));
  st = { ids };
  relayFrames.set(tabId, st);
  return st;
}

async function runInFrame(tabId, fid, url, range, asText) {
  let out;
  try {
    out = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [fid] },
      func: pageFetchFunc,
      args: [url, range || null, !!asText]
    });
  } catch (e) {
    return { ok: false, error: "页面代取失败：" + ((e && e.message) || e) };
  }
  const r = out && out[0] && out[0].result;
  if (!r) return { ok: false, error: "页面代取没有返回结果" };
  return r;
}

/**
 * 挨个框架试：视频经常嵌在 iframe 里，主框架去取会被跨域拦下，
 * 只有那个真正装了播放器的框架才能取到。最多试 4 个（有些站 iframe 几十个）。
 * HTTP 状态类错误（比如 520）不换框架重试 —— 那是服务端的态度，不是框架的问题。
 */
async function relayFetch(tabId, url, range, asText) {
  if (!tabId) return { ok: false, error: "没有来源标签页" };
  const st = await relayTargets(tabId);
  if (!st) return { ok: false, error: "无法注入原页面（可能已关闭或已跳转）" };
  if (!st.ids.length) return { ok: false, error: "原页面里没有可用的框架" };

  let last = null;
  let tried = 0;
  for (const fid of st.ids.slice()) {
    if (tried++ >= 4) break;
    const r = await runInFrame(tabId, fid, url, range, asText);
    if (r && r.ok) {
      // 成功的框架提到最前，后续请求直接命中
      st.ids = [fid].concat(st.ids.filter((x) => x !== fid));
      return r;
    }
    // 4xx（没权限 / 不存在）换框架没有意义；5xx（比如 520）可能是这个框架的身份不对，继续试下一个
    if (r && r.status && r.status >= 400 && r.status < 500) return r;
    last = r;
  }

  // 全都取不到：扔掉缓存，下次重新探一遍
  relayFrames.delete(tabId);
  return last || { ok: false, error: "页面代取失败" };
}

/**
 * 给这些域名补上 Referer / Origin。
 * 用「会话级」规则而不是动态规则：关掉浏览器就消失，不会长期改写用户正常浏览时的请求头。
 */
const REF_RULE_BASE = 9100;
const REF_RULE_MAX = 60;

async function applyRefererRules(referer, hosts) {
  let u;
  try {
    u = new URL(referer);
  } catch {
    return { ok: false, error: "referer 不是合法地址" };
  }
  const list = [...new Set((hosts || []).filter((h) => typeof h === "string" && h))].slice(0, REF_RULE_MAX);

  let old = [];
  try {
    old = await chrome.declarativeNetRequest.getSessionRules();
  } catch {
    old = [];
  }
  const removeRuleIds = old
    .map((r) => r.id)
    .filter((id) => id >= REF_RULE_BASE && id < REF_RULE_BASE + REF_RULE_MAX);

  const addRules = list.map((h, i) => ({
    id: REF_RULE_BASE + i,
    priority: 2,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "referer", operation: "set", value: referer },
        { header: "origin", operation: "set", value: u.origin }
      ]
    },
    condition: { requestDomains: [h], resourceTypes: ["xmlhttprequest", "media", "other", "object"] }
  }));

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
    // 老版本在 hls.js 里写死过一条动态规则，顺手清掉
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [9002] }).catch(() => {});
    return { ok: true, count: addRules.length, hosts: list };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------------- 消息 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "getStreams": {
          await ready;
          await loadRules(!!msg.fresh);
          await checkVersion(!!msg.fresh);
          const tabId = msg.tabId ?? sender.tab?.id;
          const scope = msg.scope === "image" ? "image" : "video";

          // 图片视图：先注入页面扫一遍 <img>，补上尺寸与「是否在视口内」这两个网络层拿不到的信息
          let pageImgCount = 0;
          if (scope === "image" && tabId != null) pageImgCount = await scanTabImages(tabId);

          const m = tabs.get(tabId);
          let items = m ? [...m.values()] : [];

          // 两个视图各管各的：图片不混进视频列表，视频也不出现在图片视图
          items = items.filter((r) => (scope === "image" ? r.kind === "img" : r.kind !== "img"));

          if (scope === "video" && rules.hideSegmentsByDefault && !msg.showSegments) {
            const nonSeg = items.filter((r) => r.kind !== "seg");
            items = nonSeg.length ? nonSeg : items;
          }

          if (scope === "image") {
            // 现在屏幕上看得见的排最前，其余按最近一次请求时间
            items.sort((a, b) => (!!b.vis ? 1 : 0) - (!!a.vis ? 1 : 0) || (b.last || 0) - (a.last || 0));
            sendResponse({
              ok: true,
              scope,
              drm: false,
              page: pageMeta.get(tabId) || null,
              items,
              pageImgCount,
              videoCount: 0,
              now: null,
              version: {
                disk: uiVersion,
                sw: swVersion,
                applied: appliedSw,
                pendingSw: swVersion !== appliedSw
              },
              rulesVersion: rules.version
            });
            break;
          }
          const order = { hls: 0, dash: 1, file: 2, seg: 3 };
          items.sort((a, b) => {
            const d = (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
            return d !== 0 ? d : b.last - a.last;
          });

          // 同一个播放列表每次刷新都换新的签名参数时，会以不同 URL 重复出现，折叠成一条
          const byKey = new Map();
          const folded = [];
          for (const it of items) {
            if (it.kind !== "hls") {
              folded.push(Object.assign({}, it));
              continue;
            }
            const k = plKey(it.url);
            const prev = byKey.get(k);
            if (!prev) {
              const copy = Object.assign({}, it);
              byKey.set(k, copy);
              folded.push(copy);
            } else {
              prev.hits = (prev.hits || 0) + (it.hits || 0);
              if (it.last > prev.last) {
                const hits = prev.hits;
                Object.assign(prev, it);
                prev.hits = hits;
              }
            }
          }
          items = folded;

          // 给 HLS 条目附上「页面侧累积到的分片数 / 时长」，弹窗据此显示真实时长
          const pls = playlists.get(tabId);
          for (const it of items) {
            if (it.kind !== "hls") {
              delete it.snap;
              continue;
            }
            const p = pls && (pls.get(plKey(it.url)) || pls.get(it.url));
            it.snap = p
              ? {
                  n: p.segments ? p.segments.length : 0,
                  dur: Math.round(p.duration || 0),
                  ended: !!p.ended,
                  drm: !!p.drm,
                  master: !!p.master
                }
              : null;
          }

          let videoCount = 0;
          const fv = frameVideos.get(tabId);
          if (fv) for (const n of fv.values()) videoCount += n || 0;

          // 顺带把图片数量带回去，弹窗切视图前就能显示角标
          let imgCount = 0;
          if (m) for (const r of m.values()) if (r.kind === "img") imgCount++;

          // 判定「哪一条才是此刻页面上正在播的那个」
          const nowInfo = annotateNow(tabId, items);

          // 正在播放的永远排最前，其余按类型 + 最近请求时间
          items.sort((a, b) => {
            if (!!b.current !== !!a.current) return b.current ? 1 : -1;
            const d = (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
            return d !== 0 ? d : b.last - a.last;
          });

          sendResponse({
            ok: true,
            scope: "video",
            drm: drmTabs.has(tabId),
            page: pageMeta.get(tabId) || null,
            items,
            now: nowInfo,
            videoCount,
            imgCount,
            version: { disk: uiVersion, sw: swVersion, applied: appliedSw, pendingSw: swVersion !== appliedSw },
            rulesVersion: rules.version
          });
          break;
        }

        case "clear":
          clearTab(msg.tabId);
          sendResponse({ ok: true });
          break;

        case "downloadFile": {
          const id = await downloadWithReferer(msg.url, msg.referer, msg.filename);
          sendResponse({ ok: true, downloadId: id });
          break;
        }

        case "downloadBatch": {
          const files = (msg.items || []).filter((i) => i.kind !== "hls" && i.kind !== "dash");
          let started = 0;
          const failed = [];
          for (const f of files) {
            try {
              const name = f.kind === "img" ? guessImageFilename(f.url, f.ct) : undefined;
              await downloadWithReferer(f.url, f.referer, name);
              started++;
            } catch (e) {
              failed.push({ url: f.url, error: String((e && e.message) || e) });
            }
          }
          sendResponse({ ok: true, started, total: files.length, failed });
          break;
        }

        case "applyUpdate": {
          await chrome.storage.local.set({ appliedSw: msg.version || swVersion });
          chrome.runtime.reload();
          sendResponse({ ok: true });
          break;
        }

        case "drmDetected": {
          const tabId = sender.tab?.id;
          if (tabId != null) {
            drmTabs.add(tabId);
            updateBadge(tabId);
          }
          sendResponse({ ok: true });
          break;
        }

        case "pageMedia": {
          const tabId = sender.tab?.id;
          ready.then(() => {
            const kind = kindOf(msg.url);
            if (tabId != null && kind) upsert(tabId, msg.url, { kind, src: msg.via || "dom" });
          });
          sendResponse({ ok: true });
          break;
        }

        case "pagePlaylist": {
          const tabId = sender.tab?.id;
          ready.then(() => storePlaylist(tabId, msg.url, msg.text, msg.ct));
          sendResponse({ ok: true });
          break;
        }

        case "pageInfo": {
          const tabId = sender.tab?.id;
          if (tabId != null && typeof msg.videoCount === "number") {
            let f = frameVideos.get(tabId);
            if (!f) {
              f = new Map();
              frameVideos.set(tabId, f);
            }
            f.set(sender.frameId ?? 0, msg.videoCount);
          }
          sendResponse({ ok: true });
          break;
        }

        case "pageState": {
          const tabId = sender.tab?.id;
          const fid = sender.frameId ?? 0;
          if (tabId != null) {
            const t = Date.now();
            let m = stateFrames.get(tabId);
            if (!m) {
              m = new Map();
              stateFrames.set(tabId, m);
            }
            m.set(fid, {
              items: Array.isArray(msg.items) ? msg.items : [],
              mse: !!msg.mse,
              at: t
            });
            // 导航 / 关闭的 frame 不会再上报，过期就丢，避免拿几十秒前的假状态做判断
            for (const [k, v] of m) if (t - v.at > 20000) m.delete(k);

            // 聚合：主 frame 排最前（播放器在 iframe 里时让主 frame 优先）
            const ids = [...m.keys()].sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b));
            const items = [];
            let mse = false;
            for (const id of ids) {
              const s = m.get(id);
              mse = mse || s.mse;
              for (const it of s.items) items.push(Object.assign({ frame: id }, it));
            }
            pageStates.set(tabId, { items, mse, at: t });
          }
          sendResponse({ ok: true });
          break;
        }

        case "diagnose": {
          await ready;
          await loadRules(true);
          const tabId = msg.tabId ?? sender.tab?.id;
          sendResponse({ ok: true, report: buildDiagnosis(tabId) });
          break;
        }

        case "relayFetch": {
          const tabId = Number(msg.tabId) || 0;
          const r = await relayFetch(tabId, msg.url, msg.range || null, !!msg.asText);
          sendResponse(r);
          break;
        }

        case "refererRules": {
          sendResponse(await applyRefererRules(msg.referer, msg.hosts));
          break;
        }

        case "getSnapshot": {
          const tabId = msg.tabId ?? sender.tab?.id;
          const p = playlistOf(tabId, msg.url);
          sendResponse({
            ok: true,
            snap: p
              ? {
                  url: p.url,
                  segments: p.segments || [],
                  init: p.init || null,
                  duration: p.duration || 0,
                  ended: !!p.ended,
                  drm: !!p.drm,
                  master: !!p.master
                }
              : null
          });
          break;
        }

        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true;
});

/* ---------------- 「当前看到的视频」判定 ---------------- */

/**
 * 一次播放往往能嗅探出十几条结果：主片、广告、预加载的下一集、封面预览、
 * 同页其它 <video>、CDN 上的花絮…… 光看 URL 判断不了哪条是用户此刻在看的东西。
 *
 * 这里只用「能在浏览器侧客观观测到」的证据打分，不猜：
 *   1. 网络活跃度 —— 正在播的流一定在持续拉分片/字节区间，广告和预加载拉完就停
 *   2. 时长对账   —— HLS 列表累积时长与播放器自报的 duration 一致
 *   3. 地址对账   —— 直链场景下 <video> 的 currentSrc 就是它
 * MSE（blob:）场景拿不到「元素 ↔ 列表」的硬连接，只能靠 1 + 2 两条间接证据，
 * 所以同时把证据文案一并返回，让用户自己能看懂「凭什么说它是」。
 */

/**
 * URL 解析缓存：判定时要拿几十条结果和几百条分片两两比对，
 * 每条都比两次 new URL 会有几万次解析，这里统一走缓存。
 */
const urlParseCache = new Map();
function parseUrl(u) {
  if (typeof u !== "string" || !u) return null;
  const hit = urlParseCache.get(u);
  if (hit !== undefined) return hit;
  let v = null;
  try {
    v = new URL(u);
  } catch {
    v = null;
  }
  if (urlParseCache.size > 3000) urlParseCache.clear();
  urlParseCache.set(u, v);
  return v;
}

/** 目录前缀（去掉文件名），用于「分片是否属于同一个列表」 */
function dirOf(url) {
  const u = parseUrl(url);
  if (!u) return "";
  const i = u.pathname.lastIndexOf("/");
  return u.origin + (i >= 0 ? u.pathname.slice(0, i + 1) : "/");
}

/**
 * 两个地址是否属于「同一部片子」：同源 + 目录前缀互相包含。
 * 分片常放在列表目录的子目录里（/v/1/ 与 /v/1/seg/），所以按前缀判而不是全等。
 * 根目录不参与关联，否则同一 CDN 上的所有视频会被算成一伙。
 */
function sameShow(a, b) {
  if (!a || !b || a === b) return false;
  const ua = parseUrl(a);
  const ub = parseUrl(b);
  if (!ua || !ub || ua.origin !== ub.origin) return false;

  const pa = dirOf(a).slice(ua.origin.length);
  const pb = dirOf(b).slice(ub.origin.length);
  if (!pa || !pb || pa === "/" || pb === "/") return false;
  const short = pa.length <= pb.length ? pa : pb;
  // 太短的公共前缀（如 "/a/"）区分度不够，容易把同站不同片子算成一条
  if (short.length < 4) return false;
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** 比对地址时忽略查询串：<video src> 上的 ?v=2 与网络请求的地址常常只有参数不同 */
function pathKey(url) {
  const x = parseUrl(url);
  return x ? x.origin + x.pathname : String(url || "");
}

/** 正在播放的 <video>：未暂停 + 可见 + 有画面尺寸；主 frame 优先，其次取面积最大的 */
function playingVideo(st) {
  const list = (st && st.items) || [];
  const cands = list.filter((v) => !v.paused && !v.ended && v.vis && v.w && v.h);
  if (!cands.length) return null;
  cands.sort((a, b) => {
    const am = a.frame === 0 || a.frame == null ? 1 : 0;
    const bm = b.frame === 0 || b.frame == null ? 1 : 0;
    if (am !== bm) return bm - am;
    return (b.area || 0) - (a.area || 0);
  });
  return cands[0];
}

const NOW_LIVE_MS = 4000; // 4 秒内还在请求 = 播放器正在消费它
const NOW_RECENT_MS = 15000; // 15 秒内算「刚活跃过」

/**
 * 给每条结果打上 now = { live, exact, durMatch, score, why }，并只挑一个 current。
 * @returns {{playing: object|null, current: object|null, hint: string}}
 */
function annotateNow(tabId, items) {
  const st = pageStates.get(tabId);
  const pv = playingVideo(st);
  const all = tabs.get(tabId);
  const now = Date.now();

  // 页面里所有视频元素的地址 → 该元素是否已暂停（同地址只要有一个在播就算在播）
  const vidSrcs = new Map();
  for (const v of (st && st.items) || []) {
    if (!v.src) continue;
    const k = pathKey(v.src);
    if (!vidSrcs.has(k) || !v.paused) vidSrcs.set(k, !!v.paused);
  }

  // 最近活跃的「数据类」请求（分片 / 直链），先筛一遍，避免每条结果都全表扫描
  const hot = [];
  if (all) {
    for (const r of all.values()) {
      if (now - r.last > NOW_RECENT_MS) continue;
      if (r.kind === "seg" || r.kind === "file") hot.push(r);
    }
    hot.sort((a, b) => b.last - a.last);
  }

  for (const it of items) {
    const rec = all && all.get(it.url);
    let live = rec ? now - rec.last : Infinity;

    // 分片还在源源不断进来 → 这个列表正在被播放器消费
    for (const r of hot) {
      if (r.url === it.url) continue;
      if (!sameShow(r.url, it.url)) continue;
      const d = now - r.last;
      if (d < live) live = d;
      if (live < 1000) break;
    }

    const k = pathKey(it.url);
    const exactPaused = vidSrcs.has(k) ? vidSrcs.get(k) : null;
    const exact = exactPaused !== null;
    const dur = it.snap && it.snap.dur ? it.snap.dur : 0;
    const durMatch = !!(pv && pv.dur > 30 && dur > 30 && Math.abs(dur - pv.dur) <= Math.max(4, pv.dur * 0.08));
    const durFar = !!(pv && pv.dur > 30 && dur > 30 && Math.abs(dur - pv.dur) > Math.max(10, pv.dur * 0.25));

    let score = 0;
    const why = [];

    if (live <= NOW_LIVE_MS) {
      score += live < 1500 ? 50 : 40;
      why.push(live < 1500 ? "此刻仍在请求数据" : `${Math.round(live / 1000)} 秒前还请求过数据`);
    } else if (live <= NOW_RECENT_MS) {
      score += 22;
      why.push(`${Math.round(live / 1000)} 秒前有过请求`);
    }

    if (exact) {
      if (exactPaused) {
        // 页面元素指向它，但那个元素已暂停 —— 它可能只是「上一个视频」，不能算强证据
        score += 25;
        why.push("页面上有 <video> 指向它（当前已暂停）");
      } else {
        score += 45;
        why.push("就是页面 <video> 的当前地址");
      }
    }

    if (durMatch) {
      // 时长完全对得上是强证据：即使已经缓冲完、不再发请求，也基本能确定是同一条
      score += 40;
      why.push(`列表时长与播放器一致（约 ${mmss(pv.dur)}）`);
    } else if (durFar) {
      score -= 30;
      why.push(`时长对不上（列表 ${mmss(dur)} / 播放器 ${mmss(pv.dur)}）`);
    }

    if (it.kind === "hls" && it.snap && it.snap.master) score -= 10;

    it.now = { live: isFinite(live) ? Math.round(live) : -1, exact, durMatch, score };
    it.why = why.join(" · ");
    it.current = false;
  }

  let best = null;
  for (const it of items) {
    if (it.kind === "seg") continue;
    if (!best || it.now.score > best.now.score) best = it;
  }
  // 40 分是「至少有一项强证据」的门槛，避免在毫无信号时瞎指一条
  const current = best && best.now.score >= 40 ? best : null;
  if (current) current.current = true;

  let hint = "";
  if (!current) {
    hint = pv
      ? "播放器在播，但没找到与它对应的请求 —— 大概已经缓冲完，不再发请求了。看「列表时长 ≈ 播放器时长」那条。"
      : "没检测到正在播放的画面。把页面上的视频点开播一下，这里就会标出对应地址。";
  }

  return {
    playing: pv ? { dur: pv.dur, cur: pv.cur, w: pv.w, h: pv.h, idx: pv.idx, frame: pv.frame | 0 } : null,
    current: current ? { url: current.url, kind: current.kind } : null,
    hint
  };
}

/* ---------------- 诊断 ---------------- */

function humanSize(n) {
  if (!n || n <= 0) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? Math.round(v) : v.toFixed(1)) + " " + u[i];
}

function mmss(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}

/**
 * 判断「页面到底有没有拿到完整视频」，这是区分下面两种情况的关键：
 *   A. 页面上能完整播 4 分钟 → 数据确实到过客户端，抓不到是我们的问题，能修
 *   B. 页面本身只有 15 秒 → 服务端只下发了 15 秒（试看/试听），客户端从未收到完整内容
 */
function buildDiagnosis(tabId) {
  const st = pageStates.get(tabId) || { items: [], mse: false, at: 0 };
  const videos = (st.items || []).map((v) => ({
    idx: v.idx | 0,
    frame: v.frame | 0,
    dur: v.dur || 0,
    cur: v.cur || 0,
    paused: !!v.paused,
    vis: !!v.vis,
    area: v.area || 0,
    buffered: (v.buf || []).map((r) => r[1]).reduce((a, b) => Math.max(a, b), 0),
    bufRanges: v.buf || [],
    seekable: (v.seek || []).map((r) => r[1]).reduce((a, b) => Math.max(a, b), 0),
    mse: !!v.mse,
    size: v.w && v.h ? `${v.w}×${v.h}` : "",
    src: v.src || ""
  }));

  const pls = [];
  const local = playlists.get(tabId);
  if (local) {
    for (const p of local.values()) {
      pls.push({
        url: p.url,
        segments: (p.segments || []).length,
        duration: p.duration || 0,
        ended: !!p.ended,
        drm: !!p.drm,
        master: !!p.master
      });
    }
  }

  const ranges = [];
  const nr = netRanges.get(tabId);
  if (nr) {
    for (const [url, e] of nr) {
      ranges.push({
        url,
        parts: e.parts.size,
        total: e.total,
        ct: e.ct,
        sample: [...e.parts].slice(0, 3)
      });
    }
  }

  const streams = [];
  const m = tabs.get(tabId);
  if (m) {
    for (const rec of m.values()) {
      if (rec.kind === "seg") continue;
      streams.push({ url: rec.url, kind: rec.kind, size: rec.size || 0, ct: rec.ct || "" });
    }
  }

  const maxDur = videos.reduce((a, v) => Math.max(a, v.dur), 0);
  const maxBuf = videos.reduce((a, v) => Math.max(a, v.buffered), 0);
  const maxSeek = videos.reduce((a, v) => Math.max(a, v.seekable), 0);
  const plMax = pls.reduce((a, p) => Math.max(a, p.duration), 0);
  const rangeTotal = ranges.reduce((a, r) => Math.max(a, r.total), 0);

  let verdict;
  if (!videos.length && !pls.length) {
    verdict = {
      level: "warn",
      title: "还没抓到任何播放信息",
      detail: "先在页面上点一次播放，让它真正去请求视频；然后再打开弹窗点「诊断」。"
    };
  } else if (maxDur >= 60 && (maxBuf >= maxDur * 0.6 || maxSeek >= maxDur * 0.6)) {
    verdict = {
      level: "ok",
      title: `页面确实拿到了完整视频（播放器时长 ${mmss(maxDur)}）`,
      detail:
        `播放器已缓冲/可定位到 ${mmss(Math.max(maxBuf, maxSeek))}，说明这 ${mmss(maxDur)} 的数据真的到过你的浏览器。` +
        "这种情况是我们某条取流路径没覆盖到，属于能修的问题——把下面的诊断内容发我，我按它继续修。"
    };
  } else if (maxDur >= 60) {
    verdict = {
      level: "warn",
      title: `播放器认为时长 ${mmss(maxDur)}，但只缓冲了 ${mmss(maxBuf)}`,
      detail:
        "页面还没把后面的部分拉下来。在页面上把视频完整播放一遍（或拖动进度条到结尾），" +
        "让它把分片都请求过，再回来点「诊断」。如果播完仍然只有开头，多半是站点按需分段下发，需要保持播放页打开再下载。"
    };
  } else if (maxDur > 0) {
    verdict = {
      level: "bad",
      title: `页面播放器本身的时长就只有 ${mmss(maxDur)}`,
      detail:
        maxDur < 20
          ? "这不是抓取问题：服务器只下发了这一段，客户端从未收到完整视频。付费/试看内容属于绕开付费墙的范畴（《著作权法》53 条、刑法 285 条），我不会写这个能力。需要完整版请通过官方渠道购买/登录。"
          : "页面拿到的就是这一段，先确认这个视频元素是不是广告/预告片（页面上可能还有另一个主播放器还没开始播放）。"
    };
  } else {
    verdict = {
      level: "warn",
      title: "播放器还没有时长信息",
      detail: "元数据还没加载完（可能被要求先点击播放）。点一下播放，等几秒后重新诊断。"
    };
  }

  const notes = [];
  const pv = playingVideo(st);
  if (pv) {
    notes.push(
      `页面主画面（视频 #${(pv.idx | 0) + 1}，${pv.w}×${pv.h}）正在播放，已播 ${mmss(pv.cur)} / 共 ${mmss(pv.dur)}。` +
        "弹窗里带「▶ 正在播放」标记的那条，就是它此刻在用的地址。"
    );
  } else if (videos.length) {
    notes.push("页面上没有正在播放的元素（已暂停 / 不可见），只能靠时长和最近的请求时间来判断。先点一下播放最准。");
  }
  if (ranges.some((r) => r.parts > 1)) {
    const r = ranges.slice().sort((a, b) => b.parts - a.parts)[0];
    notes.push(
      `检测到按字节分段拉取（HTTP 206）：已请求 ${r.parts} 个不同区间${
        r.total ? `，文件总长约 ${humanSize(r.total)}` : ""
      }。说明这是一个整文件，直接下载它就能拿到完整内容。`
    );
  } else if (rangeTotal > 0) {
    const r = ranges.find((x) => x.total > 0) || ranges[0];
    notes.push(
      `服务器支持 Range 请求${r && r.total ? `，文件总长约 ${humanSize(r.total)}` : ""}，属于整文件直链，可整段下载。`
    );
  }
  if (st.mse) notes.push("页面使用 MSE（blob: 播放）：<video src> 是内存句柄，真实地址要看下面「播放列表」那一栏。");
  if (pls.some((p) => p.drm)) notes.push("播放列表声明了 DRM/SAMPLE-AES 加密：属于受保护内容，本工具主动拒绝处理。");
  if (pls.length && plMax > 0 && pls.every((p) => !p.ended)) {
    notes.push("所有播放列表都没有 #EXT-X-ENDLIST：直播或事件流，只能下载已生成部分。");
  }

  return {
    at: Date.now(),
    verdict,
    notes,
    videos,
    playlists: pls.slice(0, 8),
    ranges: ranges.slice(0, 6),
    streams: streams.slice(0, 20)
  };
}

chrome.runtime.onInstalled.addListener(() => {
  ready.then(() => checkVersion(true));
});

/* ---------------- 下载 ---------------- */

let ruleSeq = 9100;

async function downloadWithReferer(url, referer, filename) {
  let ruleId = null;
  if (referer) {
    try {
      ruleId = ruleSeq++;
      if (ruleSeq > 9199) ruleSeq = 9100;
      let origin = "";
      try { origin = new URL(referer).origin; } catch { origin = ""; }
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ruleId],
        addRules: [{
          id: ruleId,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "referer", operation: "set", value: referer },
              ...(origin ? [{ header: "origin", operation: "set", value: origin }] : [])
            ]
          },
          condition: {
            urlFilter: "|" + url,
            resourceTypes: ["main_frame", "media", "xmlhttprequest", "other"]
          }
        }]
      });
    } catch {
      ruleId = null;
    }
  }

  const downloadId = await chrome.downloads.download({
    url,
    filename: filename || guessFilename(url),
    saveAs: false,
    conflictAction: "uniquify"
  });

  if (ruleId != null) {
    setTimeout(() => {
      chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] }).catch(() => {});
    }, 60000);
  }
  return downloadId;
}

function guessFilename(url) {
  try {
    const u = new URL(url, "https://x/");
    let name = decodeURIComponent(u.pathname.split("/").pop() || "");
    if (!name || !/\.[a-z0-9]{2,5}$/i.test(name)) name = "video.mp4";
    name = name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 90);
    return "视频嗅探/" + name;
  } catch {
    return "视频嗅探/video.mp4";
  }
}

/**
 * 图片文件名：批量保存时几十张图常常同名（1.jpg、index.jpg），
 * 统一放进「视频嗅探/图片/」，冲突交给 conflictAction: uniquify 自动加 (1)(2)。
 */
function guessImageFilename(url, ct) {
  let name = "";
  try {
    const u = new URL(url, "https://x/");
    name = decodeURIComponent(u.pathname.split("/").pop() || "");
  } catch {
    name = "";
  }
  name = String(name).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
  if (!name || !/\.[a-z0-9]{2,5}$/i.test(name)) {
    const c = String(ct || "").toLowerCase();
    const ext = c.includes("png") ? "png"
      : c.includes("webp") ? "webp"
      : c.includes("gif") ? "gif"
      : c.includes("svg") ? "svg"
      : c.includes("avif") ? "avif"
      : "jpg";
    name = "image-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1000) + "." + ext;
  }
  return "视频嗅探/图片/" + name;
}
