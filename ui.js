/* ui.js — 弹窗交互（热更新模块，改完重新打开弹窗即生效） */

const LABEL = { hls: "HLS", dash: "DASH", file: "直链", seg: "分片", img: "IMG" };
const MAX_HLS_BATCH = 12;
const DOWNLOADER_URL = chrome.runtime.getURL("downloader.html");

const $ = (id) => document.getElementById(id);
const listEl = $("list");
const emptyEl = $("empty");
const drmEl = $("drm-banner");
const hintEl = $("hint");
const updateBar = $("update-bar");
const hostEl = $("page-host");
const verEl = $("ver");

let tab = null;
let scope = "video"; // "video" | "image"
let items = [];
let filter = "all";
let selected = new Set();
let drm = false;
let lastMeta = null;
let nowInfo = null;
let pageImgCount = 0;

const nowBar = $("now-bar");
const nowText = $("now-text");

/* ---------------- 工具 ---------------- */

function fmtSize(n) {
  if (!n || n <= 0) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname.length > 40 ? "…" + u.pathname.slice(-40) : u.pathname;
  } catch { return ""; }
}

function fmtDur(sec) {
  if (!sec || sec <= 0) return "";
  const s = Math.round(sec);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

function shorten(s, max = 130) {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** 图片格式分类：优先看后缀，没有后缀再看 Content-Type */
function imgFormat(it) {
  const path = String((it && it.url) || "").split(/[?#]/)[0].toLowerCase();
  const m = /\.([a-z0-9]{2,5})$/.exec(path);
  const ext = m ? m[1] : "";
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  if (ext === "png" || ext === "webp" || ext === "gif") return ext;
  const c = String((it && it.ct) || "").toLowerCase();
  if (c.includes("jpeg") || c.includes("jpg")) return "jpg";
  if (c.includes("png")) return "png";
  if (c.includes("webp")) return "webp";
  if (c.includes("gif")) return "gif";
  return "other";
}

const IMG_FMT_LABEL = { jpg: "JPEG", png: "PNG", webp: "WEBP", gif: "GIF", other: "IMG" };

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = null;
function toast(text, ms = 1800) {
  let node = document.querySelector(".toast");
  if (!node) {
    node = document.createElement("div");
    node.className = "toast";
    document.body.appendChild(node);
  }
  node.textContent = text;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("已复制"); }
    catch { toast("复制失败"); }
    ta.remove();
  }
}

/* ---------------- 数据 ---------------- */

async function loadStreams(fresh = false) {
  if (!tab) return;
  const res = await chrome.runtime
    .sendMessage({
      type: "getStreams",
      tabId: tab.id,
      scope,
      showSegments: filter === "seg",
      fresh
    })
    .catch(() => null);
  if (!res || !res.ok) {
    items = [];
    drm = false;
    render();
    return;
  }
  items = res.items || [];
  drm = scope === "video" ? !!res.drm : false;
  nowInfo = scope === "video" ? res.now || null : null;
  lastMeta = res;
  pageImgCount = res.pageImgCount || 0;

  const v = (res.version && res.version.disk) || window.__VS_VERSION || "—";
  verEl.textContent = "v" + v;

  const pending = !!(res.version && res.version.pendingSw);
  updateBar.classList.toggle("hidden", !pending);
  if (pending) {
    $("update-text").textContent = `后台逻辑已更新到 v${res.version.sw}`;
  }

  updateScopeCounts(res);

  // 清理已消失条目的选择态
  const urls = new Set(items.map((i) => i.url));
  for (const u of [...selected]) if (!urls.has(u)) selected.delete(u);

  updateHint(res.videoCount || 0);
  render();
}

/** 两个视图的角标：视频数、图片数（图片数在视频视图下也一并返回，省一次请求） */
function updateScopeCounts(res) {
  if (scope === "image") {
    $("cnt-image").textContent = String(items.length);
  } else {
    $("cnt-video").textContent = String(items.length);
    if (typeof res.imgCount === "number") $("cnt-image").textContent = String(res.imgCount);
  }
}

/** 页面视频数 vs 已探测数：多视频只探测到一个时，直接告诉用户该怎么做 */
function updateHint(videoCount) {
  if (!hintEl) return;

  if (scope === "image") {
    if (!items.length) {
      hintEl.classList.add("hidden");
      return;
    }
    const vis = items.filter((i) => i.vis).length;
    let m = "";
    if (pageImgCount > items.length) {
      m = `页面里扫到 ${pageImgCount} 张图，已收录 ${items.length} 张。小于 5 KB 的图标、雪碧图、1×1 埋点像素会被自动过滤；想看全部可在 rules.json 里调低 minImageBytes。`;
    } else if (vis && vis < items.length) {
      m = `其中 ${vis} 张此刻就在屏幕上（已标「页面可见」）。其余多是页面其它位置的图或懒加载缓存，仍然可以保存。`;
    }
    hintEl.textContent = m;
    hintEl.classList.toggle("hidden", !m);
    return;
  }

  const sources = items.filter((i) => i.kind === "hls" || i.kind === "file" || i.kind === "dash");
  if (!sources.length) {
    hintEl.classList.add("hidden");
    return;
  }

  let msg = "";
  if (videoCount > sources.length) {
    msg = `页面里有 ${videoCount} 个 <video>，目前只探测到 ${sources.length} 个。播放器只会为「正在播的那个」去请求地址，其余视频要各自点一次播放，才会出现在这里。`;
  }
  if (!msg) {
    const tiny = items.filter((i) => i.kind === "hls" && i.snap && i.snap.dur > 0 && i.snap.dur < 30 && i.snap.n <= 2);
    if (tiny.length) {
      msg = `探测到的列表只有约 ${fmtDur(tiny[0].snap.dur)}：可能是站点只给了「试看」片段，或播放列表还没加载完整。先在页面上把视频完整播一遍，再回到这里重新下载。`;
    }
  }
  hintEl.textContent = msg;
  hintEl.classList.toggle("hidden", !msg);
}

/* ---------------- 渲染 ---------------- */

function visibleItems() {
  if (scope === "image") {
    if (filter === "all") return items;
    if (filter === "vis") return items.filter((i) => i.vis);
    return items.filter((i) => imgFormat(i) === filter);
  }
  if (filter === "all") return items;
  if (filter === "current") return items.filter((i) => i.current);
  return items.filter((i) => i.kind === filter);
}

function updateCounts() {
  const box = $(scope === "image" ? "filters-image" : "filters-video");
  if (!box) return;
  const count = {};
  if (scope === "image") {
    count.all = items.length;
    count.vis = 0;
    for (const i of items) {
      const f = imgFormat(i);
      count[f] = (count[f] || 0) + 1;
      if (i.vis) count.vis++;
    }
  } else {
    count.all = items.length;
    count.hls = 0;
    count.file = 0;
    count.seg = 0;
    count.dash = 0;
    count.current = 0;
    for (const i of items) {
      count[i.kind] = (count[i.kind] || 0) + 1;
      if (i.current) count.current++;
    }
  }
  for (const chip of box.querySelectorAll(".chip")) {
    const f = chip.dataset.f;
    chip.querySelector("i").textContent = String(count[f] ?? 0);
    chip.classList.toggle("active", f === filter);
  }
}

/** 顶部「正在播放」条：把「该点哪一条」直接说出来 */
function renderNow() {
  const cur = items.find((i) => i.current);
  const pv = nowInfo && nowInfo.playing;

  if (cur) {
    nowBar.classList.remove("hidden");
    const d = cur.snap && cur.snap.dur ? ` · 约 ${fmtDur(cur.snap.dur)}` : "";
    const where = shorten(hostOf(cur.url) + pathOf(cur.url), 52);
    nowText.innerHTML =
      `正在播放：<b>${LABEL[cur.kind] || cur.kind}</b>${escapeHtml(d)}` +
      `<br><span>${escapeHtml(where)}</span>`;
    return;
  }

  if (pv) {
    nowBar.classList.remove("hidden");
    nowText.innerHTML =
      `播放器在播（${escapeHtml(fmtDur(pv.dur) || "时长未知")}），但没匹配到对应请求` +
      `<br><span>多半已经缓冲完、不再发请求了。看时长相符的那条。</span>`;
    return;
  }

  nowBar.classList.add("hidden");
}

function freshText(ms) {
  if (ms < 0) return "";
  if (ms < 1200) return "刚刚还在请求";
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒前请求`;
  return "";
}

function render() {
  updateCounts();
  if (scope === "video") renderNow();
  else nowBar.classList.add("hidden");
  listEl.textContent = "";
  emptyEl.classList.toggle("hidden", items.length > 0 || drm);
  drmEl.classList.toggle("hidden", !drm);

  if (!items.length) {
    emptyEl.classList.remove("hidden");
    if (scope === "image") {
      emptyEl.querySelector(".empty-title").textContent = "还没嗅探到图片";
      emptyEl.querySelector(".empty-tip").textContent =
        "滚动一下页面，让图片真正加载（懒加载的图要滚到才会请求），再点右上角「刷新」。小于 5 KB 的图标与埋点像素会被自动过滤。";
    } else {
      emptyEl.querySelector(".empty-title").textContent = "还没嗅探到视频";
      emptyEl.querySelector(".empty-tip").textContent =
        "在页面上点击播放，让视频真正开始加载，再点右上角「刷新」。";
    }
    syncFooter();
    return;
  }

  const list = visibleItems();
  if (!list.length) {
    emptyEl.classList.remove("hidden");
    if (filter === "current") {
      emptyEl.querySelector(".empty-title").textContent = "没找到正在播放的那条";
      emptyEl.querySelector(".empty-tip").textContent =
        "先在页面上让视频真正播起来（进度条在走），再点右上角「刷新」。";
    } else if (scope === "image") {
      emptyEl.querySelector(".empty-title").textContent = "该格式下没有图片";
      emptyEl.querySelector(".empty-tip").textContent = "切换到「全部」查看其它已嗅探到的图片。";
    } else {
      emptyEl.querySelector(".empty-title").textContent = "该分类下没有条目";
      emptyEl.querySelector(".empty-tip").textContent = "切换到「全部」查看其它已嗅探到的地址。";
    }
    syncFooter();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const it of list) frag.appendChild(rowEl(it));
  listEl.appendChild(frag);
  syncFooter();
}

function rowEl(it) {
  const isImg = it.kind === "img";
  const row = document.createElement("div");
  row.className =
    "item" +
    (isImg ? " img-row" : "") +
    (selected.has(it.url) ? " sel" : "") +
    (it.current ? " current" : "");

  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.className = "chk";
  chk.checked = selected.has(it.url);
  chk.addEventListener("change", () => {
    if (chk.checked) selected.add(it.url);
    else selected.delete(it.url);
    row.classList.toggle("sel", chk.checked);
    syncFooter();
  });

  const main = document.createElement("div");
  main.className = "main";

  const head = document.createElement("div");
  head.className = "item-head";

  const fmt = isImg ? imgFormat(it) : "";

  const badge = document.createElement("span");
  badge.className = "badge " + (isImg ? "img" : it.kind || "file");
  badge.textContent = isImg ? IMG_FMT_LABEL[fmt] || "IMG" : LABEL[it.kind] || "FILE";

  const meta = document.createElement("span");
  meta.className = "meta";
  const bits = [];
  if (isImg) {
    // 懒加载的图没真正加载过，naturalWidth 为 0 —— 明说「未知」，不留空白让人猜
    bits.push(it.w && it.h ? `${it.w}×${it.h}` : "尺寸未知");
  }
  if (it.kind === "hls" && it.snap) {
    if (it.snap.master) {
      bits.push("主列表");
    } else if (it.snap.n) {
      const d = fmtDur(it.snap.dur);
      bits.push(`约 ${d || "—"} · ${it.snap.n} 分片`);
    }
  }
  if (it.size) bits.push(fmtSize(it.size));
  if (hostOf(it.url)) bits.push(hostOf(it.url));
  if (it.src === "dom" && !isImg) bits.push("页面元素");
  if (it.src === "hook") bits.push("播放器请求");
  if (it.kind === "seg" && it.hits > 1) bits.push(`${it.hits} 次`);
  if (!isImg && it.now && it.now.live >= 0) {
    const f = freshText(it.now.live);
    if (f) bits.push(f);
  }
  meta.textContent = bits.join(" · ");

  // 只有十几秒的列表单独标出来：多数是试看片段或播放列表还没加载完
  if (it.kind === "hls" && it.snap && it.snap.dur > 0 && it.snap.dur < 30 && it.snap.n <= 2) {
    const warn = document.createElement("span");
    warn.className = "warn";
    warn.textContent = "疑似试看";
    meta.append(" ", warn);
  }

  if (it.current) {
    const live = document.createElement("span");
    live.className = "badge live";
    live.textContent = "▶ 正在播放";
    head.append(live);
  }
  head.append(badge);
  // 图片：此刻就在屏幕上的单独标出来，方便一眼挑（放标题行，不挤占元信息）
  if (isImg && it.vis) {
    const vis = document.createElement("span");
    vis.className = "badge vis-tag";
    vis.textContent = "页面可见";
    head.append(vis);
  }
  head.append(meta);

  const urlEl = document.createElement("div");
  urlEl.className = "url";
  urlEl.textContent = shorten(it.url);
  urlEl.title = it.url;

  const actions = document.createElement("div");
  actions.className = "actions";

  const btnDl = document.createElement("button");
  btnDl.className = "btn tiny";
  if (it.kind === "hls") {
    btnDl.textContent = "下载并合并";
    btnDl.title = "分片合并后直接输出 MP4（可直接播放）；HEVC/加密流转为原始 .ts";
    btnDl.addEventListener("click", () => openDownloader(it, false));
  } else if (it.kind === "dash") {
    btnDl.textContent = "复制地址";
    btnDl.addEventListener("click", () => copyText(it.url));
  } else {
    btnDl.textContent = isImg ? "保存" : "下载";
    btnDl.addEventListener("click", async () => {
      btnDl.disabled = true;
      const res = await chrome.runtime
        .sendMessage({
          type: "downloadFile",
          url: it.url,
          referer: it.referer || (tab ? tab.url : ""),
          kind: it.kind,
          ct: it.ct
        })
        .catch(() => null);
      if (res && res.ok) toast(isImg ? "已保存到 视频嗅探/图片" : "已开始下载");
      else {
        toast("下载失败");
        btnDl.disabled = false;
      }
    });
  }

  const btnCopy = document.createElement("button");
  btnCopy.className = "btn tiny plain";
  btnCopy.textContent = "复制";
  btnCopy.addEventListener("click", () => copyText(it.url));

  actions.append(btnDl, btnCopy);

  // 判定依据：明说「凭什么认为这条是正在播的那个」，不做黑箱
  const showWhy = it.why && (it.current || (it.now && it.now.score >= 20));
  if (showWhy) {
    const why = document.createElement("div");
    why.className = "why" + (it.current ? " live" : "");
    why.textContent = it.why;
    main.append(head, urlEl, why, actions);
  } else {
    main.append(head, urlEl, actions);
  }
  row.append(chk, ...(isImg ? [thumbEl(it)] : []), main);
  return row;
}

/** 图片缩略图：直接用远程地址渲染（页面通常已有缓存），失败就留一个占位方块 */
function thumbEl(it) {
  const box = document.createElement("div");
  box.className = "thumb";
  const img = document.createElement("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = "";
  img.src = it.url;
  img.addEventListener("error", () => box.classList.add("bad"), { once: true });
  box.appendChild(img);
  return box;
}

function syncFooter() {
  const n = selected.size;
  const label = scope === "image" ? "保存选中" : "下载选中";
  $("btn-dl").disabled = n === 0;
  $("btn-dl").textContent = n ? `${label} (${n})` : label;
  const all = visibleItems();
  const allSelected = all.length > 0 && all.every((i) => selected.has(i.url));
  $("chk-all").checked = allSelected;
}

/* ---------------- 操作 ---------------- */

function openDownloader(it, auto) {
  const q = new URLSearchParams({
    url: it.url,
    referer: it.referer || (tab ? tab.url : ""),
    title: (tab && tab.title) || "video",
    tabId: tab ? String(tab.id) : "",
    auto: auto ? "1" : "0"
  });
  chrome.tabs.create({ url: DOWNLOADER_URL + "?" + q.toString() });
}

/** 批量 HLS：只开一个下载页，队列依次下载，避免开一堆标签页 */
function openBatchDownloader(list) {
  const title = (tab && tab.title) || "video";
  const q = new URLSearchParams({
    batch: JSON.stringify(list.map((i) => ({ url: i.url, title }))),
    referer: (list[0] && list[0].referer) || (tab ? tab.url : ""),
    title,
    tabId: tab ? String(tab.id) : "",
    auto: "1"
  });
  chrome.tabs.create({ url: DOWNLOADER_URL + "?" + q.toString() });
}

/* ---------------- 全部停止 ---------------- */

async function downloaderTabs() {
  const all = await chrome.tabs.query({}).catch(() => []);
  return all.filter((t) => (t.url || "").startsWith(DOWNLOADER_URL));
}

async function syncStopBtn() {
  const btn = $("btn-stop");
  if (!btn) return;
  const n = (await downloaderTabs()).length;
  btn.classList.toggle("hidden", n === 0);
  btn.textContent = n > 1 ? `全部停止 (${n})` : "全部停止";
}

async function stopEverything() {
  const btn = $("btn-stop");
  btn.disabled = true;
  btn.textContent = "停止中…";

  const targets = await downloaderTabs();
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const activeId = active ? active.id : -1;

  // 1) 广播：新版本下载页立即 abort 在途请求（旧版本收不到，靠第 3 步关页兜底）
  chrome.runtime.sendMessage({ type: "stopAll" }).catch(() => {});

  // 2) 取消本扩展通过 chrome.downloads 发起的下载（多轮，防止后台刚好又提交下一个）
  let canceled = 0;
  for (let i = 0; i < 3; i++) {
    const items = await chrome.downloads.search({ state: "in_progress" }).catch(() => []);
    let hit = 0;
    for (const d of items) {
      if (d.state === "in_progress" && d.byExtensionId === chrome.runtime.id) {
        await chrome.downloads.cancel(d.id).catch(() => {});
        hit++;
        canceled++;
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    if (!hit && i > 0) break;
  }

  // 3) 关掉所有下载页：无论新旧版本，关页即断流，绝不残留后台请求
  let closed = 0;
  const ordered = targets.slice().sort((a, b) => (a.id === activeId ? 1 : 0) - (b.id === activeId ? 1 : 0));
  for (const t of ordered) {
    const ok = await chrome.tabs.remove(t.id).then(() => true).catch(() => false);
    if (ok) closed++;
  }

  toast(`已停止：取消 ${canceled} 个下载、关闭 ${closed} 个下载页`, 2600);
  btn.disabled = false;
  setTimeout(syncStopBtn, 600);
}

async function downloadSelected() {
  const picked = items.filter((i) => selected.has(i.url));
  if (!picked.length) return;

  if (scope === "image") {
    $("btn-dl").disabled = true;
    $("btn-dl").textContent = "提交中…";
    const res = await chrome.runtime.sendMessage({ type: "downloadBatch", items: picked }).catch(() => null);
    if (res && res.ok) {
      const bad = res.total - res.started;
      toast(
        bad
          ? `已保存 ${res.started}/${res.total} 张，${bad} 张失败（可能被防盗链拦下）`
          : `已保存 ${res.started} 张图片 → 视频嗅探/图片`,
        2600
      );
    } else {
      toast("批量保存失败");
    }
    syncFooter();
    return;
  }

  const files = picked.filter((i) => i.kind === "file" || i.kind === "seg");
  const hls = picked.filter((i) => i.kind === "hls");
  const dash = picked.filter((i) => i.kind === "dash");

  $("btn-dl").disabled = true;
  $("btn-dl").textContent = "提交中…";

  if (files.length) {
    const res = await chrome.runtime.sendMessage({ type: "downloadBatch", items: files }).catch(() => null);
    if (res && res.ok) {
      toast(`已提交 ${res.started}/${res.total} 个直链下载`);
    } else {
      toast("批量下载失败");
    }
  }

  if (hls.length) {
    const take = hls.slice(0, MAX_HLS_BATCH);
    openBatchDownloader(take);
    if (hls.length > MAX_HLS_BATCH) {
      toast(`一次最多处理 ${MAX_HLS_BATCH} 个 HLS，其余请再选一次`, 3200);
    } else if (!files.length) {
      toast(`已开始下载 ${take.length} 个 HLS（同一页面排队）`, 2400);
    }
  }

  if (dash.length && !files.length && !hls.length) {
    toast("DASH 暂不支持批量，请复制地址后用其它工具处理", 2600);
  }

  syncStopBtn();
  syncFooter();
}

/** 智能选择：视频=所有 HLS + 每个域名体积最大的直链；图片=此刻页面上可见的那些 */
function smartSelect() {
  selected.clear();

  if (scope === "image") {
    const vis = items.filter((i) => i.vis);
    const pool = vis.length
      ? vis
      : items.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 20);
    for (const it of pool) selected.add(it.url);
    render();
    toast(
      vis.length
        ? `已选 ${selected.size} 张「页面可见」的图`
        : `页面上没有可见的图，已选体积最大的 ${selected.size} 张`
    );
    return;
  }

  const byHost = new Map();
  for (const it of items) {
    if (it.kind === "hls") {
      selected.add(it.url);
    } else if (it.kind === "file") {
      const h = hostOf(it.url);
      const prev = byHost.get(h);
      if (!prev || (it.size || 0) > (prev.size || 0)) byHost.set(h, it);
    }
  }
  for (const it of byHost.values()) selected.add(it.url);
  render();
  toast(`已选 ${selected.size} 项`);
}

/* ---------------- 事件绑定 ---------------- */

$("btn-refresh").addEventListener("click", () => loadStreams(true));

/* ---------------- 诊断：页面到底有没有拿到完整视频 ---------------- */

const diagEl = $("diag");
const diagBody = $("diag-body");

function rangeText(ranges) {
  if (!ranges || !ranges.length) return "无";
  return ranges.map((r) => `${r[0]}s–${r[1]}s`).join("、");
}

function renderDiagnosis(rep) {
  const v = rep.verdict || { level: "warn", title: "诊断", detail: "" };
  const parts = [];

  parts.push(
    `<div class="diag-verdict ${v.level}"><strong>${escapeHtml(v.title)}</strong>${
      v.detail ? `<p>${escapeHtml(v.detail)}</p>` : ""
    }</div>`
  );

  if (rep.notes && rep.notes.length) {
    parts.push(`<ul class="diag-notes">${rep.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`);
  }

  if (rep.videos && rep.videos.length) {
    parts.push(`<div class="diag-sec"><h4>播放器状态（页面自报，最可信）</h4>`);
    rep.videos.forEach((it, i) => {
      parts.push(
        `<div class="diag-row"><span class="k">视频 ${i + 1}</span><span class="v">${
          it.dur ? `时长 ${fmtDur(it.dur)}` : "时长未知"
        } · 已缓冲到 ${it.buffered ? it.buffered.toFixed(1) + "s" : "0s"}${
          it.size ? ` · ${it.size}` : ""
        }${it.mse ? " · MSE(blob)" : ""}</span></div>`
      );
      parts.push(
        `<div class="diag-row"><span class="k">缓冲区间</span><span class="v mono">${escapeHtml(
          rangeText(it.bufRanges)
        )}</span></div>`
      );
    });
    parts.push(`</div>`);
  }

  if (rep.playlists && rep.playlists.length) {
    parts.push(`<div class="diag-sec"><h4>播放列表（页面请求过的）</h4>`);
    rep.playlists.forEach((p) => {
      parts.push(
        `<div class="diag-row"><span class="k">列表</span><span class="v">${
          p.segments
        } 个分片 · ${p.duration ? fmtDur(p.duration) : "时长未知"}${p.ended ? "" : " · 无 ENDLIST"}${
          p.drm ? " · 加密/DRM" : ""
        }</span></div>`
      );
      parts.push(`<div class="diag-url mono">${escapeHtml(shorten(p.url, 120))}</div>`);
    });
    parts.push(`</div>`);
  }

  if (rep.ranges && rep.ranges.length) {
    parts.push(`<div class="diag-sec"><h4>字节分段（HTTP 206）</h4>`);
    rep.ranges.forEach((r) => {
      parts.push(
        `<div class="diag-row"><span class="k">${r.parts} 段</span><span class="v">${
          r.total ? `文件总长 ${fmtSize(r.total)}` : "总长未知"
        }</span></div>`
      );
      parts.push(`<div class="diag-url mono">${escapeHtml(shorten(r.url, 120))}</div>`);
    });
    parts.push(`</div>`);
  }

  if (rep.streams && rep.streams.length) {
    parts.push(`<div class="diag-sec"><h4>已归档的媒体地址</h4>`);
    rep.streams.forEach((s) => {
      parts.push(
        `<div class="diag-row"><span class="k">${LABEL[s.kind] || s.kind || "?"}</span><span class="v">${
          s.size ? fmtSize(s.size) : ""
        }</span></div>`
      );
      parts.push(`<div class="diag-url mono">${escapeHtml(shorten(s.url, 120))}</div>`);
    });
    parts.push(`</div>`);
  }

  diagBody.innerHTML = parts.join("");
  diagEl.classList.remove("hidden");
}

function diagAsText(rep) {
  const v = rep.verdict || {};
  const L = [];
  L.push("=== 视频嗅探下载器 诊断报告 ===");
  L.push(`结论：${v.title || ""}`);
  if (v.detail) L.push(`说明：${v.detail}`);
  (rep.notes || []).forEach((n) => L.push(`· ${n}`));
  L.push("");
  L.push(`播放器时长/缓冲：${
    (rep.videos || []).map((it) => `${it.dur || 0}s(缓冲${it.buffered || 0}s)`).join(" | ") || "无"
  }`);
  (rep.playlists || []).forEach((p) => L.push(`列表：${p.segments} 片 / ${Math.round(p.duration)}s / ${p.url}`));
  (rep.ranges || []).forEach((r) => L.push(`字节分段：${r.parts} 段 / 总长 ${r.total} / ${r.url}`));
  (rep.streams || []).forEach((s) => L.push(`地址：${s.kind} ${s.url}`));
  return L.join("\n");
}

let lastReport = null;

async function runDiagnose() {
  if (!tab) return;
  diagEl.classList.remove("hidden");
  diagBody.innerHTML = `<p class="diag-wait">正在分析页面请求…</p>`;
  const res = await chrome.runtime
    .sendMessage({ type: "diagnose", tabId: tab.id })
    .catch(() => null);
  if (!res || !res.ok) {
    diagBody.innerHTML =
      `<p class="diag-wait">诊断不可用：后台脚本还是旧版本。` +
      `去 chrome://extensions 点一次本扩展的「刷新」，之后就能用了。</p>`;
    return;
  }
  lastReport = res.report;
  renderDiagnosis(res.report);
}

$("btn-diag").addEventListener("click", runDiagnose);
$("btn-diag-close").addEventListener("click", () => diagEl.classList.add("hidden"));
$("btn-diag-copy").addEventListener("click", () => {
  if (!lastReport) return toast("先点「诊断」");
  copyText(diagAsText(lastReport));
});


$("btn-clear").addEventListener("click", async () => {
  if (!tab) return;
  await chrome.runtime.sendMessage({ type: "clear", tabId: tab.id }).catch(() => {});
  selected.clear();
  items = [];
  render();
  toast("已清空，请重新播放");
});

$("btn-smart").addEventListener("click", smartSelect);
$("btn-dl").addEventListener("click", downloadSelected);
$("btn-stop").addEventListener("click", stopEverything);

// 「只看这条」：切到当前播放分类并自动勾选，少点两下
$("btn-now").addEventListener("click", () => {
  const cur = items.find((i) => i.current);
  if (!cur) return;
  filter = "current";
  selected.clear();
  selected.add(cur.url);
  render();
  toast("已选中正在播放的这条，点右下角下载即可");
});

// 有下载页在跑时显示「全部停止」
setInterval(syncStopBtn, 1500);

$("chk-all").addEventListener("change", (e) => {
  const list = visibleItems();
  if (e.target.checked) list.forEach((i) => selected.add(i.url));
  else list.forEach((i) => selected.delete(i.url));
  render();
});

/* ---------------- 视图切换（视频 / 图片） ---------------- */

function switchScope(next) {
  if (!next || next === scope) return;
  scope = next;
  filter = "all";
  selected.clear();
  for (const b of document.querySelectorAll(".scope-btn")) {
    b.classList.toggle("active", b.dataset.s === scope);
  }
  $("filters-video").classList.toggle("hidden", scope !== "video");
  $("filters-image").classList.toggle("hidden", scope !== "image");
  // 诊断是给视频用的（播放器时长/缓冲），图片视图不需要
  $("btn-diag").classList.toggle("hidden", scope !== "video");
  hintEl.classList.add("hidden");
  loadStreams(true);
}

$("scope").addEventListener("click", (e) => {
  const btn = e.target.closest && e.target.closest(".scope-btn");
  if (btn) switchScope(btn.dataset.s);
});

// 两套筛选栏共用一套逻辑：data-f 按当前视图解释
document.addEventListener("click", async (e) => {
  const chip = e.target.closest && e.target.closest(".chip");
  if (!chip) return;
  filter = chip.dataset.f;
  if (scope === "video" && filter === "seg") await loadStreams();
  else render();
});

$("btn-apply").addEventListener("click", async () => {
  $("btn-apply").disabled = true;
  $("btn-apply").textContent = "应用中…";
  const v = lastMeta && lastMeta.version ? lastMeta.version.sw : "";
  await chrome.runtime.sendMessage({ type: "applyUpdate", version: v }).catch(() => null);
  // 扩展重载后本页面立即失效，无需再操作
});

/* ---------------- 启动 ---------------- */

(async function init() {
  // 支持 ?tabId=N 指定目标标签页（便于在独立标签页里调试）
  const forced = Number(new URLSearchParams(location.search).get("tabId")) || 0;
  if (forced) {
    tab = await chrome.tabs.get(forced).catch(() => null);
  } else {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active;
  }

  if (!tab) {
    emptyEl.querySelector(".empty-title").textContent = "没有活动标签页";
    return;
  }
  try { hostEl.textContent = new URL(tab.url).host; }
  catch { hostEl.textContent = "—"; }

  if (!/^https?:/.test(tab.url || "")) {
    listEl.textContent = "";
    emptyEl.classList.remove("hidden");
    emptyEl.querySelector(".empty-title").textContent = "当前页面不支持嗅探";
    emptyEl.querySelector(".empty-tip").textContent = "请在普通网页（http/https）中使用。";
    return;
  }

  verEl.textContent = "v" + (window.__VS_VERSION || "—");
  syncStopBtn();
  await loadStreams(true);
})();
