/* hls.js — HLS(m3u8) 分片下载、AES-128 解密、保存与「全部停止」（热更新模块） */

const q = new URLSearchParams(location.search);
const AUTO = q.get("auto") === "1";
const REFERER = q.get("referer") || "";
const PAGE_TITLE = q.get("title") || "video";
const SINGLE_URL = q.get("url") || "";
const TAB_ID = Number(q.get("tabId")) || 0;

const el = (id) => document.getElementById(id);
const $src = el("src");
const $queue = el("queue");
const $start = el("btn-start");
const $cancel = el("btn-cancel");
const $phase = el("phase");
const $bar = el("bar");
const $count = el("count");
const $bytes = el("bytes");
const $log = el("log");
const $note = el("auto-note");
const $dirName = el("dir-name");
const $btnDir = el("btn-dir");
const $btnDirReset = el("btn-dir-reset");
const $fmt = el("fmt");

const DEFAULT_LABEL = "下载目录 / 视频嗅探";
const BUFFER_LIMIT = 1200 * 1024 * 1024; // 未指定目录时整段暂存内存，超过即中止

let aborted = false;
let running = false;
let netCtl = null;
let currentWriter = null;
let totalBytes = 0;
let savedBytes = 0;
let dirHandle = null;

/* ---------------- 队列 ---------------- */

function parseQueue() {
  const raw = q.get("batch");
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const list = arr
          .filter((x) => x && typeof x.url === "string" && x.url)
          .map((x) => ({ url: x.url, title: x.title || PAGE_TITLE }));
        if (list.length) return list;
      }
    } catch (e) {
      /* 解析失败退回单条 */
    }
  }
  return SINGLE_URL ? [{ url: SINGLE_URL, title: PAGE_TITLE }] : [];
}

const QUEUE = parseQueue();

/* ---------------- 日志 / 进度 ---------------- */

function log(msg) {
  $log.textContent += ($log.textContent ? "\n" : "") + msg;
  $log.scrollTop = $log.scrollHeight;
}

function human(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return Math.round(n / 1024) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

function updateBytes() {
  // 重封装时「写入的体积」会比「下载的体积」小（TS 有包头开销），两个数都显示，避免看着像丢数据
  if (totalBytes && Math.abs(totalBytes - savedBytes) > 1024) {
    $bytes.textContent = `写入 ${human(savedBytes)} · 已下载 ${human(totalBytes)}`;
    return;
  }
  $bytes.textContent = savedBytes ? human(savedBytes) : "—";
}

function progress(done, total) {
  $count.textContent = `${done} / ${total} 分片`;
  $bar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
}

function showQueue(index, count, title) {
  if (count <= 1) {
    $queue.classList.add("hidden");
    return;
  }
  $queue.classList.remove("hidden");
  $queue.textContent = `批量队列：第 ${index + 1} / ${count} 个 · ${title}`;
}

/* ---------------- 保存目录（记住选择，不再每次弹框） ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("vs-dl", 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("kv")) req.result.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const rq = db.transaction("kv", "readonly").objectStore("kv").get(key);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function idbSet(key, val) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const rq = db.transaction("kv", "readwrite").objectStore("kv").put(val, key);
      rq.onsuccess = () => resolve();
      rq.onerror = () => reject(rq.error);
    });
  } catch {
    /* 忽略 */
  }
}

async function idbDel(key) {
  try {
    const db = await openDB();
    await new Promise((resolve) => {
      const rq = db.transaction("kv", "readwrite").objectStore("kv").delete(key);
      rq.onsuccess = () => resolve();
      rq.onerror = () => resolve();
    });
  } catch {
    /* 忽略 */
  }
}

function updateDirLabel() {
  $dirName.textContent = dirHandle ? dirHandle.name : DEFAULT_LABEL;
  $btnDir.textContent = dirHandle ? "更改" : "选择目录";
  $btnDirReset.classList.toggle("hidden", !dirHandle);
}

/**
 * 取回上次记住的目录。
 * @param {boolean} interactive 允许弹系统目录选择框（必须在用户点击里调用）
 * @param {boolean} forcePick   忽略缓存，强制重新选
 */
async function ensureDir(interactive, forcePick) {
  if (!window.showDirectoryPicker) return null;

  if (!forcePick) {
    const saved = await idbGet("dir");
    if (saved && typeof saved.queryPermission === "function") {
      try {
        const st = await saved.queryPermission({ mode: "readwrite" });
        if (st === "granted") return saved;
        if (interactive && st === "prompt") {
          const r = await saved.requestPermission({ mode: "readwrite" });
          if (r === "granted") return saved;
        }
      } catch {
        /* 句柄失效 */
      }
    }
  }

  if (!interactive) return null;
  const picked = await window.showDirectoryPicker({ id: "vs-dl", mode: "readwrite", startIn: "downloads" });
  await idbSet("dir", picked);
  return picked;
}

/* ---------------- 写入器 ---------------- */

function safeName(s) {
  return (s || "video").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80).trim() || "video";
}

async function uniqueName(dir, name) {
  const m = name.match(/\.[^.]+$/);
  const base = m ? name.slice(0, -m[0].length) : name;
  const ext = m ? m[0] : "";
  let cand = name;
  for (let i = 1; i < 300; i++) {
    try {
      await dir.getFileHandle(cand);
      cand = `${base} (${i})${ext}`;
    } catch {
      return cand;
    }
  }
  return `${base}-${Date.now()}${ext}`;
}

/** 直接写入用户选定的目录：流式落盘，不占内存、不弹框 */
async function createDirWriter(dir, name) {
  const finalName = await uniqueName(dir, name);
  const fh = await dir.getFileHandle(finalName, { create: true });
  const w = await fh.createWritable();
  return {
    name: finalName,
    async write(chunk) { await w.write(chunk); },
    async close(patches) {
      // 收尾时把总时长回填到文件头的 mvhd/mdhd（支持定位写才能做，失败就跳过）
      if (patches && patches.length) {
        try {
          for (const p of patches) await w.write({ type: "write", position: p.at, data: p.bytes });
        } catch (e) {
          /* 不支持定位写：时长显示可能不准，文件本身仍然可用 */
        }
      }
      await w.close();
    },
    async abort() { try { await w.abort(); } catch { /* 忽略 */ } }
  };
}

/** 没有指定目录时：内存暂存，结束后交给浏览器下载（saveAs=false，不弹框） */
function createBufferWriter(name, mime) {
  const chunks = [];
  let held = 0;
  return {
    name,
    async write(chunk) {
      chunks.push(chunk);
      held += chunk.byteLength;
      if (held > BUFFER_LIMIT) {
        throw new Error("文件超过 1.2GB，内存暂存已满。请点「选择目录」后重新下载（改为直接写盘）。");
      }
    },
    async close(patches) {
      if (patches && patches.length) {
        // 内存里已经有全部字节，直接在自己身上改：把总时长写回文件头
        const merged = new Uint8Array(held);
        let o = 0;
        for (const c of chunks) {
          merged.set(c, o);
          o += c.byteLength;
        }
        for (const p of patches) {
          if (p.at >= 0 && p.at + p.bytes.length <= merged.length) merged.set(p.bytes, p.at);
        }
        chunks.length = 0;
        chunks.push(merged);
      }
      const blob = new Blob(chunks, { type: mime });
      const url = URL.createObjectURL(blob);
      const revoke = () => setTimeout(() => URL.revokeObjectURL(url), 120000);
      try {
        if (window.chrome && chrome.downloads) {
          const id = await chrome.downloads.download({
            url,
            filename: "视频嗅探/" + name,
            saveAs: false,
            conflictAction: "uniquify"
          });
          // 若浏览器开了「下载前询问每个文件的保存位置」，任务会停在 paused，提示一次即可
          setTimeout(async () => {
            try {
              const [d] = await chrome.downloads.search({ id });
              if (d && d.state === "in_progress" && d.paused) {
                log("⚠ 浏览器在等你确认保存位置：在下载栏点一次「允许」，或在 chrome://settings/downloads 关闭「下载前询问每个文件的保存位置」，之后就不会再弹");
              }
            } catch {
              /* 忽略 */
            }
          }, 2500);
          const onDone = (d) => {
            if (d.id === id && d.state && d.state.current !== "in_progress") {
              URL.revokeObjectURL(url);
              chrome.downloads.onChanged.removeListener(onDone);
            }
          };
          chrome.downloads.onChanged.addListener(onDone);
        } else {
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          revoke();
        }
      } catch (e) {
        revoke();
        throw e;
      }
    },
    async abort() { chunks.length = 0; }
  };
}

/* ---------------- 网络（可中断 + 三层回退） ---------------- */

function signal() {
  return netCtl ? netCtl.signal : undefined;
}

/** 值得重试的状态：限速、网关抖动、CDN 边缘 5xx */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);
/** host -> 已经验证可行的取法 */
const HOST_STRATEGY = new Map();
const refererHosts = new Set();
let relayAnnounced = false;
/** CDN 连续报错时自动放慢，避免把边缘节点打毛（520 有时就是并发太高） */
let paceMs = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostOfUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64 || "");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 把这一批请求涉及的域名登记给后台，让它补上 Referer/Origin（会话级规则，关浏览器就消失） */
async function registerReferer(hosts) {
  if (!REFERER) return;
  let changed = false;
  for (const h of hosts) {
    if (!h || refererHosts.has(h) || refererHosts.size >= 40) continue;
    refererHosts.add(h);
    changed = true;
  }
  if (!changed) return;
  try {
    await chrome.runtime.sendMessage({ type: "refererRules", referer: REFERER, hosts: [...refererHosts] });
  } catch (e) {
    /* 补不上也不算致命，后面还有「页面代取」这条腿 */
  }
}

function statusHint(status) {
  if (!status) return "请求在网络上就被拦掉了（跨域限制或连接被重置）";
  if (status === 401 || status === 403) return "需要登录态，或触发了防盗链校验";
  if (status === 404 || status === 410) return "地址已失效（一次性签名过期，或分片已被清理）";
  if (status === 429) return "请求太频繁，被限速了";
  if (status === 451) return "因地区 / 版权限制不可访问";
  if (status >= 520 && status <= 530) return "CDN 边缘节点拒绝了这次请求（多为防盗链或连接数限制）";
  return "服务器返回错误";
}

function trimUrl(url) {
  const s = String(url || "");
  return s.length > 96 ? s.slice(0, 64) + "…" + s.slice(-24) : s;
}

function decorate(err, url, what) {
  const e = err instanceof Error ? err : new Error(String(err));
  const st = e.status || 0;
  const where = what || trimUrl(url);
  const out = new Error(`${e.message || "请求失败"}${where ? " — " + where : ""}`);
  out.status = st;
  const tried = ["直连"];
  if (TAB_ID) tried.push("回到原页面代取");
  if (REFERER) tried.push("补 Referer");
  out.hint = statusHint(st) + `。已尝试：${tried.join(" / ")}`;
  return out;
}

/**
 * 单次取：direct = 扩展页直接请求；relay = 回到源页面、用页面自己的身份请求。
 * relay 是绕开防盗链的关键：Referer / Cookie / Sec-Fetch-* 全都和页面自身一模一样。
 */
async function oneShot(url, range, asText, mode) {
  if (mode === "relay") {
    const res = await chrome.runtime.sendMessage({
      type: "relayFetch",
      tabId: TAB_ID,
      url,
      range: range || null,
      asText: !!asText
    });
    if (!res) throw new Error("页面代取没有响应");
    if (!res.ok) {
      const e = new Error(res.error || "HTTP " + res.status);
      e.status = res.status || 0;
      e.relay = true;
      throw e;
    }
    if (asText) return res.text || "";
    const bytes = b64ToBytes(res.b64);
    totalBytes += bytes.byteLength;
    updateBytes();
    return bytes.buffer;
  }

  const init = { credentials: "include", cache: "no-store", signal: signal() };
  if (range && range[1] > 0) {
    // 字节区间分片：同一个文件的不同区间，必须带 Range 才不会重复拿到开头
    init.headers = { Range: `bytes=${range[0]}-${range[0] + range[1] - 1}` };
  }
  const res = await fetch(url, init);
  if (!res.ok && res.status !== 206) {
    const e = new Error("HTTP " + res.status);
    e.status = res.status;
    throw e;
  }
  if (asText) return await res.text();
  const buf = await res.arrayBuffer();
  totalBytes += buf.byteLength;
  updateBytes();
  return buf;
}

async function oneShotWithRetry(url, range, asText, mode) {
  const tries = mode === "direct" ? 3 : 2;
  let last = null;
  for (let i = 0; i < tries; i++) {
    if (aborted) throw new Error("已停止");
    try {
      const r = await oneShot(url, range, asText, mode);
      if (paceMs > 0) paceMs = Math.max(0, paceMs - 20);
      return r;
    } catch (e) {
      if (aborted) throw e;
      last = e;
      const st = e && e.status;
      if (st && (st >= 500 || st === 429)) paceMs = Math.min(400, paceMs + 80);
      // 4xx 里明确是「没权限 / 地址没了 / 被限速」之外的情况，重试没意义
      if (st && st >= 400 && st < 500 && !RETRY_STATUS.has(st)) break;
      if (i < tries - 1) await sleep(250 * (i + 1) + Math.floor(Math.random() * 150));
    }
  }
  throw last;
}

/** 一条请求的全部分支：先用已验证的取法，不行就换另一种，最后补 Referer 再试一次 */
async function fetchSmart(url, range, asText, what) {
  const host = hostOfUrl(url);
  const cached = HOST_STRATEGY.get(host);
  const order = cached === "relay" ? ["relay", "direct"] : ["direct", "relay"];
  let last = null;

  for (const mode of order) {
    if (mode === "relay" && !TAB_ID) continue;
    try {
      const r = await oneShotWithRetry(url, range, asText, mode);
      HOST_STRATEGY.set(host, mode);
      if (mode === "relay" && !relayAnnounced) {
        relayAnnounced = true;
        log("这个 CDN 不认扩展页发出的请求（直连被拒）→ 已改为回到原页面代取，能下但会慢一点");
      }
      return r;
    } catch (e) {
      if (aborted) throw e;
      last = e;
    }
  }

  // 还有一招：把源页面的 Referer / Origin 补上再直连一次（有些站只校验这两个）
  if (REFERER) {
    await registerReferer([host]);
    try {
      const r = await oneShotWithRetry(url, range, asText, "direct");
      HOST_STRATEGY.set(host, "direct");
      return r;
    } catch (e) {
      if (aborted) throw e;
      last = e;
    }
  }

  throw decorate(last, url, what);
}

async function fetchBuf(url, range) {
  return fetchSmart(url, range, false, "");
}

async function fetchText(url, what) {
  const text = await fetchSmart(url, null, true, what || "播放列表");
  return String(text);
}

/* ---------------- 播放列表解析 ---------------- */

const absUrl = (u, base) => {
  try { return new URL(u, base).href; } catch { return u; }
};

function parseAttrs(str) {
  const out = {};
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) out[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, "");
  return out;
}

function parsePlaylist(text, base) {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const attrs = parseAttrs(lines[i]);
    let j = i + 1;
    while (j < lines.length && lines[j].startsWith("#")) j++;
    if (j < lines.length) {
      variants.push({
        url: absUrl(lines[j], base),
        bandwidth: parseInt(attrs.BANDWIDTH || "0", 10) || 0,
        resolution: attrs.RESOLUTION || ""
      });
    }
    i = j;
  }
  if (variants.length) {
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { master: true, variants };
  }

  const segments = [];
  let key = null;
  let init = null;
  let ended = false;
  let mediaSeq = 0;
  let pendingDur = 0;
  let duration = 0;
  let brNext = null;
  let lastBr = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-TARGETDURATION:")) continue;
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSeq = parseInt(line.split(":")[1], 10) || 0;
      continue;
    }
    if (line === "#EXT-X-ENDLIST") { ended = true; continue; }
    if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttrs(line.slice(11));
      if (a.URI) init = { url: absUrl(a.URI, base), key };
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttrs(line.slice(11));
      if (!a.METHOD || a.METHOD === "NONE") { key = null; continue; }
      if (a.METHOD !== "AES-128") {
        throw new Error(
          `该流使用 ${a.METHOD} 加密（属于受保护内容），本工具不支持解密。请通过官方渠道观看。`
        );
      }
      key = { method: "AES-128", uri: absUrl(a.URI || "", base), iv: a.IV || "" };
      log("检测到 AES-128 加密，将在下载时自动解密");
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const [lenS, offS] = line.slice(17).trim().split("@");
      const len = parseInt(lenS, 10) || 0;
      brNext = [offS != null ? parseInt(offS, 10) || 0 : lastBr ? lastBr[0] + lastBr[1] : 0, len];
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pendingDur = parseFloat(line.slice(8)) || 0;
      continue;
    }
    if (line.startsWith("#")) continue;

    const seg = { url: absUrl(line, base), key, dur: pendingDur, seq: mediaSeq + segments.length };
    if (brNext) {
      seg.range = brNext;
      lastBr = brNext;
      brNext = null;
    }
    segments.push(seg);
    duration += pendingDur;
    pendingDur = 0;
  }

  return { master: false, segments, init, ended, duration };
}

/* ---------------- 页面侧快照（补全滑窗列表） ---------------- */

async function getSnapshot(url) {
  try {
    const res = await chrome.runtime.sendMessage({ type: "getSnapshot", url, tabId: TAB_ID || undefined });
    return res && res.ok ? res.snap : null;
  } catch {
    return null;
  }
}

function snapshotToPlan(snap) {
  if (!snap || !Array.isArray(snap.segments) || !snap.segments.length) return null;
  const segments = snap.segments.map((s, i) => ({
    url: s.u,
    key: s.k && s.k.uri ? { method: "AES-128", uri: s.k.uri, iv: s.k.iv || "" } : null,
    dur: s.d || 0,
    range: Array.isArray(s.br) ? s.br : null,
    seq: typeof s.s === "number" ? s.s : i
  }));
  const initKey = snap.init && snap.init.k && snap.init.k.uri
    ? { method: "AES-128", uri: snap.init.k.uri, iv: snap.init.k.iv || "" }
    : null;
  return {
    master: false,
    segments,
    init: snap.init ? { url: snap.init.url, key: initKey } : null,
    ended: !!snap.ended,
    duration: snap.duration || segments.reduce((a, b) => a + b.dur, 0)
  };
}

/**
 * 关键修复：很多站的播放列表是「滑动窗口」，页面每次只请求最近几片。
 * 我们下载时再去拉一次，拿到的可能只有 15 秒，而页面侧历次请求累积的快照才是完整序列。
 */
const segIdOf = (s) => (s.range ? `${s.url}#${s.range[0]}-${s.range[1]}` : s.url);

function mergeSnapshot(plan, snap) {
  const sp = snapshotToPlan(snap);
  if (!sp) return plan;

  const curUrls = plan.segments.map(segIdOf);
  const curSet = new Set(curUrls);
  const snapSet = new Set(sp.segments.map(segIdOf));
  const curInSnap = curUrls.every((u) => snapSet.has(u));
  const snapInCur = sp.segments.every((s) => curSet.has(segIdOf(s)));

  if (curInSnap && sp.segments.length > plan.segments.length) {
    const extra = plan.segments.filter((s) => !snapSet.has(segIdOf(s)));
    const segments = sp.segments.concat(extra);
    log(`页面侧已累积 ${sp.segments.length} 个分片，当前列表只有 ${plan.segments.length} 个 → 按完整序列下载`);
    return Object.assign({}, sp, {
      segments,
      duration: segments.reduce((a, s) => a + (s.dur || 0), 0),
      ended: sp.ended || plan.ended
    });
  }

  if (snapInCur) return plan;

  const missing = sp.segments.filter((s) => !curSet.has(segIdOf(s)));
  if (!missing.length) return plan;

  // 完全不重叠：多半是另一个视频 / 另一个分P，不硬拼，避免拼出乱七八糟的文件
  log(`提示：页面侧另有 ${missing.length} 个分片与本列表不连续，已忽略（可能是另一个视频）`);
  return plan;
}

/* ---------------- AES-128 解密 ---------------- */

const keyCache = new Map();

function getKey(uri) {
  if (keyCache.has(uri)) return keyCache.get(uri);
  const p = (async () => {
    const raw = await fetchBuf(uri);
    return crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]);
  })();
  keyCache.set(uri, p);
  return p;
}

function ivFromHex(hex) {
  const h = hex.replace(/^0x/i, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const byte = h.slice(i * 2, i * 2 + 2);
    out[i] = byte ? parseInt(byte, 16) : 0;
  }
  return out;
}

function ivFromSeq(seq) {
  const iv = new Uint8Array(16);
  const dv = new DataView(iv.buffer);
  const big = BigInt(seq);
  dv.setUint32(8, Number(big >> 32n));
  dv.setUint32(12, Number(big & 0xffffffffn));
  return iv;
}

async function decrypt(buf, key, seq) {
  const ck = await getKey(key.uri);
  const iv = key.iv ? ivFromHex(key.iv) : ivFromSeq(seq);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, ck, buf));
}

/* ---------------- 单个任务 ---------------- */

async function downloadItem(entry, index, count) {
  $src.textContent = entry.url;
  showQueue(index, count, entry.title);

  let plUrl = entry.url;
  let text = "";
  let plan;
  try {
    text = await fetchText(entry.url);
    plan = parsePlaylist(text, entry.url);

    if (plan.master) {
      const best = plan.variants[0];
      log(`主列表含 ${plan.variants.length} 个码率，选用最高：${Math.round(best.bandwidth / 1000)} kbps ${best.resolution}`);
      text = await fetchText(best.url, "码率列表");
      plUrl = best.url;
      plan = parsePlaylist(text, best.url);
      if (plan.master) throw new Error("播放列表嵌套层级异常");
    }
    plan = mergeSnapshot(plan, await getSnapshot(plUrl));
  } catch (err) {
    if (aborted) throw err;
    // 拉不到列表（需要 POST、URL 带一次性签名等）时，退回页面侧已抓到的分片
    const sp = snapshotToPlan(await getSnapshot(entry.url));
    if (!sp) throw err;
    log("直接拉取播放列表失败，改用页面侧已抓到的分片快照继续下载");
    plan = sp;
  }

  if (!plan.segments.length) throw new Error("播放列表中没有分片");

  // 分片常常和列表不在同一台机器上（列表在 A 站，流在 B CDN），
  // 所以要把这一批真正会请求到的域名全登记进去，否则 B 站拿不到 Referer 会直接拒。
  const planHosts = [hostOfUrl(plUrl), hostOfUrl(entry.url), hostOfUrl(plan.init && plan.init.url)];
  for (const s of plan.segments) {
    planHosts.push(hostOfUrl(s.url));
    if (s.key && s.key.uri) planHosts.push(hostOfUrl(s.key.uri));
  }
  await registerReferer(planHosts);

  const isFmp4 = !!plan.init || plan.segments.some((s) => /\.(m4s|mp4)(\?|$)/i.test(s.url));
  const wantMp4 = !$fmt || $fmt.value !== "ts";

  // 先拿第一片「探个路」：只有 H.264 才值得重封装成 MP4，其它编码保持原始 .ts
  let remuxable = false;
  let head = null;
  if (wantMp4 && !isFmp4 && typeof VSRemux !== "undefined") {
    try {
      const s0 = plan.segments[0];
      let buf = new Uint8Array(await fetchBuf(s0.url, s0.range));
      if (s0.key) buf = await decrypt(buf, s0.key, s0.seq);
      const info = VSRemux.probe(buf);
      if (info.video === "avc") {
        remuxable = true;
        head = buf;
        log(
          info.audio === "aac"
            ? "流是 H.264 + AAC：合并时直接重封装成 MP4，下载完就能双击播放"
            : `流是 H.264（${info.audio ? "音频 " + info.audio : "无音频"}）：合并时直接重封装成 MP4`
        );
      } else if (info.scrambled) {
        log("⚠ 分片是加密 TS（transport_scrambling_control），保持原始 .ts");
      } else {
        log(`视频编码为 ${info.video || "未知"}，不做重封装，保持原始 .ts（要 mp4 可用 ffmpeg 转）`);
      }
    } catch (e) {
      if (aborted) throw e;
      log("⚠ 首个分片探测失败：" + ((e && e.message) || e) + "；先按原始 .ts 继续尝试");
    }
  }

  const ext = isFmp4 || remuxable ? ".mp4" : ".ts";
  const mime = isFmp4 || remuxable ? "video/mp4" : "video/mp2t";
  const baseName = QUEUE.length > 1 ? `${entry.title} ${index + 1}` : entry.title;
  const filename = safeName(baseName) + ext;

  if (!plan.ended) log("⚠ 列表未含 ENDLIST，可能是直播流，仅下载当前已完成的部分");
  const mmss = (s) => `${Math.floor(s / 60)} 分 ${String(Math.round(s % 60)).padStart(2, "0")} 秒`;
  log(`共 ${plan.segments.length} 个分片，时长约 ${mmss(plan.duration || 0)}`);
  if ((plan.duration || 0) > 0 && plan.duration < 30 && plan.segments.length <= 2) {
    log("⚠ 这条列表本身只有十几秒：可能是站点的「试看」片段，或页面还没加载完整列表。先在页面上把视频完整播放一遍，再回来重新下载。");
  }

  const writer = dirHandle
    ? await createDirWriter(dirHandle, filename)
    : createBufferWriter(filename, mime);
  currentWriter = writer;

  let writtenBytes = 0;
  let outChain = Promise.resolve();
  let remux = null;

  if (remuxable) {
    remux = new VSRemux.Remuxer({
      onChunk: (out) => {
        writtenBytes += out.length;
        outChain = outChain.then(() => writer.write(out));
      }
    });
  }

  const write = async (chunk) => {
    if (remux) {
      remux.push(chunk); // 重封装模式下由 onChunk 分片落盘
    } else {
      await writer.write(chunk);
      writtenBytes += chunk.byteLength;
    }
    savedBytes = writtenBytes;
    updateBytes();
  };

  try {
    if (plan.init) {
      let head0 = new Uint8Array(await fetchBuf(plan.init.url));
      if (plan.init.key) head0 = await decrypt(head0, plan.init.key, 0);
      await write(head0);
    }
    if (head) await write(head);

    const rest = head ? plan.segments.slice(1) : plan.segments;
    await runPipeline(rest, write, index, count, plan.segments.length, head ? 1 : 0);

    if (remux) {
      remux.flush();
      savedBytes = writtenBytes; // 尾部分片在收尾时才写出，这里补一次统计
      updateBytes();
    }
    await outChain;
    await writer.close(remux ? remux.patchBytes() : null);
    currentWriter = null;

    log(`✓ 已保存：${writer.name}（${human(writtenBytes)}）${dirHandle ? "" : " → 下载目录/视频嗅探"}`);
    if (remux) {
      const st = remux.stats();
      log(
        `  MP4：H.264 ${st.width}×${st.height} · ${st.videoFrames} 帧` +
          `${st.hasAudio ? ` · 音频 ${st.audioFrames} 帧` : " · 无音频"} · 时长约 ${mmss(st.duration)}`
      );
    }
  } catch (err) {
    try { await writer.abort(); } catch { /* 忽略 */ }
    currentWriter = null;
    throw err;
  }
}

async function runPipeline(segments, write, itemIndex, itemCount, totalCount, doneBase) {
  const CONCURRENCY = 3;
  const total = totalCount || segments.length;
  const base = doneBase || 0;
  const ready = new Map();
  let nextFetch = 0;
  let nextWrite = 0;
  let chain = Promise.resolve();

  const flush = () => {
    chain = chain.then(async () => {
      while (ready.has(nextWrite)) {
        const chunk = ready.get(nextWrite);
        ready.delete(nextWrite);
        await write(chunk);
        nextWrite++;
        const done = base + nextWrite;
        progress(done, total);
        const tag = itemCount > 1 ? `（${itemIndex + 1}/${itemCount}）` : "";
        $phase.textContent = `下载中${tag} ${Math.round((done / total) * 100)}%`;
      }
    });
    return chain;
  };

  const worker = async () => {
    while (!aborted) {
      const i = nextFetch++;
      if (i >= segments.length) return;
      const seg = segments[i];
      let buf;
      try {
        if (paceMs > 0) await sleep(paceMs);
        buf = new Uint8Array(await fetchBuf(seg.url, seg.range));
        if (seg.key) buf = await decrypt(buf, seg.key, seg.seq);
      } catch (e) {
        if (aborted) return; // 停止时静默退出
        throw e;
      }
      ready.set(i, buf);
      await flush();
    }
  };

  const n = Math.min(CONCURRENCY, segments.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  await flush();

  if (aborted) throw new Error("已停止");
}

/* ---------------- 停止 ---------------- */

function stopAll(reason) {
  if (aborted) return;
  aborted = true;
  $cancel.disabled = true;

  // 真正掐断在途请求：AbortController 会让所有 fetch 立即失败
  try { netCtl && netCtl.abort(); } catch { /* 忽略 */ }
  try { currentWriter && currentWriter.abort(); } catch { /* 忽略 */ }
  currentWriter = null;

  if (running) {
    $phase.textContent = "正在停止…";
    $phase.className = "";
    log(reason || "已停止：所有进行中的请求已中断");
  }
}

/* ---------------- 主流程 ---------------- */

async function start() {
  if (running || !QUEUE.length) return;
  running = true;
  aborted = false;
  netCtl = new AbortController();
  totalBytes = 0;
  savedBytes = 0;
  updateBytes();
  progress(0, 0);

  $start.disabled = true;
  $cancel.disabled = false;
  $log.textContent = "";
  $phase.textContent = "解析播放列表…";
  $phase.className = "";

  try {
    await registerReferer(QUEUE.map((e) => hostOfUrl(e.url)));

    // 非交互地取回已授权目录；没授权就走「下载目录」，绝不弹框
    dirHandle = dirHandle || (await ensureDir(false, false));

    for (let i = 0; i < QUEUE.length; i++) {
      if (aborted) break;
      await downloadItem(QUEUE[i], i, QUEUE.length);
    }

    if (aborted) {
      $phase.textContent = "已停止";
      $phase.className = "";
      log(`已停止：共 ${QUEUE.length} 个任务，已完成部分不再继续`);
    } else {
      $phase.textContent = "完成";
      $phase.className = "ok";
      $bar.style.width = "100%";
      $count.textContent = QUEUE.length > 1 ? `全部完成 ${QUEUE.length} 个` : $count.textContent;
    }
  } catch (err) {
    if (aborted) {
      $phase.textContent = "已停止";
      $phase.className = "";
    } else {
      const msg = String((err && err.message) || err);
      $phase.textContent = "失败";
      $phase.className = "err";
      log("✗ " + msg);
      if (err && err.hint) {
        log("  原因：" + err.hint);
        log("  接着可以试：① 回到原页面把视频重新播放一下（刷新一次性签名），再点「开始下载」；② 确认那个页面本身还能正常播放；③ 换个标签页重新嗅探一次。");
      }
    }
  } finally {
    running = false;
    $start.disabled = false;
    $cancel.disabled = true;
    $queue.textContent = "";
    if (!$phase.classList.contains("err") && $phase.textContent !== "已停止" && $phase.textContent !== "完成") {
      $phase.textContent = "就绪";
      $phase.className = "";
    }
  }
}

/* ---------------- 事件绑定 ---------------- */

$start.addEventListener("click", start);

$cancel.addEventListener("click", () => {
  stopAll("已请求取消：正在中断全部请求");
});

$btnDir.addEventListener("click", async () => {
  try {
    const h = await ensureDir(true, true);
    if (h) {
      dirHandle = h;
      updateDirLabel();
      log(`保存目录已设为：${h.name}（本页后续下载直接写入，不再弹框）`);
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;
    log("✗ 选择目录失败：" + ((e && e.message) || e));
  }
});

$btnDirReset.addEventListener("click", async () => {
  await idbDel("dir");
  dirHandle = null;
  updateDirLabel();
  log("已改回默认保存位置：下载目录 / 视频嗅探");
});

// 关页面 / 刷页面时，顺手把在途请求掐掉，避免后台继续拉流
window.addEventListener("beforeunload", () => {
  try { netCtl && netCtl.abort(); } catch { /* 忽略 */ }
  try { currentWriter && currentWriter.abort(); } catch { /* 忽略 */ }
});

// 弹窗里点「全部停止」时，所有下载页同时收到
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "stopAll") stopAll("已收到「全部停止」指令");
});

/* ---------------- 初始化 ---------------- */

(async function init() {
  updateDirLabel();
  if (!QUEUE.length) {
    $src.textContent = "（缺少 url 参数）";
    $start.disabled = true;
    log("未取到播放列表地址，请从扩展弹窗重新点击「下载并合并」。");
    return;
  }
  $src.textContent = QUEUE.length > 1 ? `${QUEUE.length} 个 HLS 地址（批量）` : QUEUE[0].url;
  if (QUEUE.length > 1) showQueue(0, QUEUE.length, QUEUE[0].title);

  if (AUTO) {
    if ($note) $note.classList.remove("hidden");
    log("批量模式：自动开始（不弹保存框）");
    // 已有授权目录则复用；没有则写入「下载/视频嗅探」，全程无需手工点目录
    dirHandle = await ensureDir(false, false);
    updateDirLabel();
    setTimeout(start, 150);
  }
})();
