/**
 * remux.js — MPEG-TS → MP4（分片 MP4 / fMP4）重封装
 *
 * 为什么需要它：
 * 绝大多数 HLS 的分片是 MPEG-TS（.ts），把分片按顺序拼起来得到的 .ts 虽然能播，
 * 但 Windows 播放器、剪辑软件、部分手机都认不出来，用户还得自己 ffmpeg 转一遍。
 * 这里把 TS 里的 H.264 / AAC 基本流拆出来，重新封装成标准 MP4（.mp4），
 * 合并完就是可直接双击播放的文件。
 *
 * 设计取舍：
 * - 用「分片 MP4」（每个关键帧开一个新的 moof+mdat），才能边下边写、内存占用恒定；
 *   普通 MP4 需要把 moov 写在文件头（要提前知道所有样点偏移），做不到流式写盘。
 * - 只处理 H.264 + AAC（HLS 的绝大多数情况）；HEVC / MP3 音频 / scrambled TS 原样保留 .ts。
 * - 纯函数 + 无 DOM 依赖，可以直接在 Node 里 require 做字节级测试。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.VSRemux = api;
})(typeof globalThis !== "undefined" ? globalThis : null, function () {
  "use strict";

  const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const VIDEO_TS = 90000;
  const WRAP = 8589934592; // 2^33，PTS/DTS 的 33 位回绕周期

  /* ================= 基础工具 ================= */

  function zeros(n) {
    return new Uint8Array(n);
  }

  function concat(list) {
    let n = 0;
    for (let i = 0; i < list.length; i++) n += list[i].length;
    const out = new Uint8Array(n);
    let o = 0;
    for (let i = 0; i < list.length; i++) {
      out.set(list[i], o);
      o += list[i].length;
    }
    return out;
  }

  function be16(n) {
    return new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
  }

  function be32(n) {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  }

  function be32s(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n | 0);
    return b;
  }

  function be64(n) {
    return concat([be32(Math.floor(n / 4294967296)), be32(n >>> 0)]);
  }

  function fourcc(s) {
    const b = new Uint8Array(4);
    for (let i = 0; i < 4; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }

  function box(type) {
    const body = concat(Array.prototype.slice.call(arguments, 1));
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(fourcc(type), 4);
    out.set(body, 8);
    return out;
  }

  function fullBox(type, ver, flags) {
    const parts = [new Uint8Array([ver & 0xff, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff])];
    const rest = Array.prototype.slice.call(arguments, 3);
    const body = concat(parts.concat(rest));
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(fourcc(type), 4);
    out.set(body, 8);
    return out;
  }

  const MATRIX = new Uint8Array([
    0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0,
    0, 0, 0, 0, 0x40, 0x00, 0x00, 0x00
  ]);

  /* ================= Annex B / SPS ================= */

  /** 去掉 NAL 尾部的起始码残留 0x00（4 字节起始码会让前一帧多一个 0） */
  function trimZeros(buf) {
    let end = buf.length;
    while (end > 0 && buf[end - 1] === 0) end--;
    return buf.subarray(0, end);
  }

  function splitAnnexB(buf) {
    const out = [];
    const n = buf.length;
    let start = -1;
    let i = 0;

    while (i + 3 <= n) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
        start = i + 3;
        i += 3;
        break;
      }
      i++;
    }
    if (start < 0) return out;

    while (i + 3 <= n) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
        if (i > start) out.push(trimZeros(buf.subarray(start, i)));
        start = i + 3;
        i += 3;
      } else {
        i++;
      }
    }
    if (start >= 0 && start < n) out.push(trimZeros(buf.subarray(start, n)));
    return out;
  }

  /** 去掉防竞争字节（0x00 0x00 0x03 → 0x00 0x00） */
  function toRbsp(nal) {
    const out = new Uint8Array(nal.length);
    let o = 0;
    for (let i = 0; i < nal.length; i++) {
      if (i + 2 < nal.length && nal[i] === 0 && nal[i + 1] === 0 && nal[i + 2] === 3) {
        out[o++] = 0;
        out[o++] = 0;
        i += 2;
      } else {
        out[o++] = nal[i];
      }
    }
    return out.subarray(0, o);
  }

  class BitReader {
    constructor(b) {
      this.b = b;
      this.pos = 0;
    }
    u1() {
      const byte = this.b[this.pos >> 3] || 0;
      const bit = (byte >> (7 - (this.pos & 7))) & 1;
      this.pos++;
      return bit;
    }
    u(n) {
      let v = 0;
      for (let i = 0; i < n; i++) v = (v << 1) | this.u1();
      return v >>> 0;
    }
    ue() {
      let zeros = 0;
      while (this.pos < this.b.length * 8 && this.u1() === 0) {
        zeros++;
        if (zeros > 32) return 0;
      }
      let v = 0;
      for (let i = 0; i < zeros; i++) v = (v << 1) | this.u1();
      return Math.pow(2, zeros) - 1 + v;
    }
    se() {
      const k = this.ue();
      return k & 1 ? (k + 1) / 2 : -(k / 2);
    }
  }

  /** 从 SPS 里读出画面宽高（比 avc1 里随便填一个值靠谱） */
  function parseSpsDims(sps) {
    try {
      const r = new BitReader(toRbsp(sps.subarray(1)));
      const profileIdc = r.u(8);
      r.u(8);
      r.u(8);
      r.ue(); // sps_id

      let chroma = 1;
      const high = profileIdc === 100 || profileIdc === 110 || profileIdc === 122 || profileIdc === 244 ||
        profileIdc === 44 || profileIdc === 83 || profileIdc === 86 || profileIdc === 118 ||
        profileIdc === 128 || profileIdc === 138 || profileIdc === 139 || profileIdc === 134 || profileIdc === 135;
      if (high) {
        chroma = r.ue();
        if (chroma === 3) r.u1();
        r.ue();
        r.ue();
        r.u1();
        if (r.u1()) {
          const count = chroma === 3 ? 12 : 8;
          for (let i = 0; i < count; i++) {
            if (r.u1()) {
              const size = i < 6 ? 16 : 64;
              let last = 8;
              let next = 8;
              for (let j = 0; j < size; j++) {
                if (next) next = (last + r.se() + 256) % 256;
                last = next ? next : last;
              }
            }
          }
        }
      }

      r.ue(); // log2_max_frame_num_minus4
      const pocType = r.ue();
      if (pocType === 0) {
        r.ue();
      } else if (pocType === 1) {
        r.u1();
        r.se();
        r.se();
        const n = r.ue();
        for (let i = 0; i < n; i++) r.se();
      }
      r.ue(); // max_num_ref_frames
      r.u1(); // gaps_in_frame_num_value_allowed_flag
      const wMbs = r.ue() + 1;
      const hMaps = r.ue() + 1;
      const frameOnly = r.u1();
      if (!frameOnly) r.u1();
      r.u1(); // direct_8x8_inference_flag
      let cl = 0;
      let cr = 0;
      let ct = 0;
      let cb = 0;
      if (r.u1()) {
        cl = r.ue();
        cr = r.ue();
        ct = r.ue();
        cb = r.ue();
      }
      const subW = chroma === 1 || chroma === 2 ? 2 : 1;
      const subH = chroma === 1 ? 2 : 1;
      const width = wMbs * 16 - (cl + cr) * subW;
      const height = (2 - frameOnly) * hMaps * 16 - (ct + cb) * subH * (2 - frameOnly);
      return { width, height, profileIdc };
    } catch (e) {
      return null;
    }
  }

  /* ================= ADTS（AAC） ================= */

  function parseAdts(buf, off) {
    if (off + 7 > buf.length) return null;
    if (buf[off] !== 0xff || (buf[off + 1] & 0xf0) !== 0xf0) return null;
    const profile = (buf[off + 2] >> 6) & 0x03;
    const sfIndex = (buf[off + 2] >> 2) & 0x0f;
    const channels = ((buf[off + 2] & 0x01) << 2) | ((buf[off + 3] >> 6) & 0x03);
    const frameLen = ((buf[off + 3] & 0x03) << 11) | (buf[off + 4] << 3) | ((buf[off + 5] >> 5) & 0x07);
    const protectionAbsent = buf[off + 1] & 0x01;
    const hdrLen = protectionAbsent ? 7 : 9;
    const blocks = buf[off + 6] & 0x03;
    if (!frameLen || frameLen <= hdrLen) return null;
    if (sfIndex >= SAMPLE_RATES.length) return null;
    return { profile, sfIndex, channels, frameLen, hdrLen, samples: (blocks + 1) * 1024 };
  }

  /* ================= TS 解复用 ================= */

  const PES_HEADER_ONLY = { 0xbc: 1, 0xbe: 1, 0xbf: 1, 0xf0: 1, 0xf1: 1, 0xf2: 1, 0xf8: 1, 0xff: 1 };

  /** 33 位 PTS/DTS：32..30 | 29..22 | 21..15 | 14..7 | 6..0 */
  function readTs33(b, off) {
    return ((b[off] & 0x0e) >> 1) * 1073741824 +
      b[off + 1] * 4194304 +
      ((b[off + 2] & 0xfe) >> 1) * 32768 +
      b[off + 3] * 128 +
      ((b[off + 4] & 0xfe) >> 1);
  }

  function parsePes(buf) {
    if (buf.length < 9 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1) return null;
    if (PES_HEADER_ONLY[buf[3]]) return null;
    const flags = buf[7];
    const ptsDts = (flags >> 6) & 0x03;
    const hdrLen = buf[8];
    let pts = 0;
    let dts = 0;
    if (ptsDts === 2 || ptsDts === 3) pts = readTs33(buf, 9);
    dts = ptsDts === 3 ? readTs33(buf, 14) : pts;
    const start = 9 + hdrLen;
    if (start >= buf.length) return null;
    return { pts, dts, data: buf.subarray(start) };
  }

  class TsParser {
    constructor() {
      this.rest = null;
      this.pmtPid = -1;
      this.videoPid = -1;
      this.audioPid = -1;
      this.videoType = 0;
      this.audioType = 0;
      this.pes = Object.create(null);
      this.onVideo = null;
      this.onAudio = null;
      this.error = null;
      this.scrambled = false;
      this.locked = false;
    }

    push(bytes) {
      let buf = bytes;
      if (this.rest && this.rest.length) {
        buf = concat([this.rest, bytes]);
        this.rest = null;
      }
      const len = buf.length;
      let off = 0;
      while (off + 188 <= len) {
        if (buf[off] !== 0x47 || (off + 188 < len && buf[off + 188] !== 0x47)) {
          off++;
          continue;
        }
        this._packet(buf.subarray(off, off + 188));
        off += 188;
      }
      if (off < len) this.rest = buf.slice(off);
    }

    _packet(p) {
      if (p[1] & 0x80) return; // transport_error_indicator
      const pusi = (p[1] & 0x40) !== 0;
      const pid = ((p[1] & 0x1f) << 8) | p[2];
      const scrambling = (p[3] >> 6) & 0x03;
      const afc = (p[3] >> 4) & 0x03;
      if (scrambling) {
        this.scrambled = true;
        this.error = this.error || "TS 包被加密（transport_scrambling_control），无法重封装";
        return;
      }

      let off = 4;
      if (afc & 0x02) {
        const afLen = p[4];
        off = 5 + afLen;
        if (off > 188) return;
      }
      if (!(afc & 0x01)) return;
      if (off >= 188) return;

      if (pid === 0 || pid === this.pmtPid) return this._psi(p.subarray(off), pusi);
      if (pid === this.videoPid || pid === this.audioPid) this._pesPacket(pid, p.subarray(off), pusi);
    }

    _psi(payload, pusi) {
      if (!pusi || !payload.length) return;
      const start = 1 + payload[0];
      const d = payload.subarray(start);
      if (d.length < 12) return;
      const tableId = d[0];
      const sectionLen = ((d[1] & 0x0f) << 8) | d[2];
      if (!sectionLen) return;
      const end = Math.min(d.length, 3 + sectionLen - 4);

      if (tableId === 0x00) {
        for (let p = 8; p + 4 <= end; p += 4) {
          const prog = (d[p] << 8) | d[p + 1];
          if (!prog) continue;
          this.pmtPid = ((d[p + 2] & 0x1f) << 8) | d[p + 3];
          return;
        }
        return;
      }

      if (tableId !== 0x02) return;
      let p = 8;
      if (p + 4 > end) return;
      const progInfoLen = ((d[p + 2] & 0x0f) << 8) | d[p + 3];
      p += 4 + progInfoLen;
      const streams = [];
      while (p + 5 <= end) {
        const type = d[p];
        const epid = ((d[p + 1] & 0x1f) << 8) | d[p + 2];
        const esLen = ((d[p + 3] & 0x0f) << 8) | d[p + 4];
        p += 5 + esLen;
        streams.push({ type, pid: epid });
      }
      this._streams(streams);
    }

    _streams(list) {
      if (this.locked || !list.length) return;
      const isVideo = (t) => t === 0x1b || t === 0x24 || t === 0x27 || t === 0x01 || t === 0x02 || t === 0x10;
      let v = null;
      let a = null;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!v && isVideo(s.type)) v = s;
        else if (!a && s.type === 0x0f) a = s;
      }
      if (!v) {
        this.videoType = -1;
        return;
      }
      // 只对 H.264 做重封装；其它编码记录下来让上层决定「保持 .ts」
      this.videoType = v.type;
      if (v.type === 0x1b) this.videoPid = v.pid;
      if (a) {
        this.audioPid = a.pid;
        this.audioType = a.type;
      }
      this.locked = true;
    }

    _pesPacket(pid, payload, pusi) {
      let st = this.pes[pid];
      if (pusi) {
        if (st && st.chunks.length) this._finalize(pid, st);
        st = { chunks: [], len: 0 };
        this.pes[pid] = st;
      } else if (!st) {
        return;
      }
      if (payload.length) {
        st.chunks.push(payload);
        st.len += payload.length;
      }
    }

    _finalize(pid, st) {
      const buf = st.chunks.length === 1 ? st.chunks[0] : concat(st.chunks);
      st.chunks = [];
      st.len = 0;
      const pes = parsePes(buf);
      if (!pes) return;
      if (pid === this.videoPid) {
        if (this.onVideo) this.onVideo(pes);
      } else if (pid === this.audioPid) {
        if (this.onAudio) this.onAudio(pes);
      }
    }

    /** 流结束时把最后一个 PES 收尾（它后面没有新的起始包，不会自动触发） */
    drain() {
      const pids = Object.keys(this.pes);
      for (let i = 0; i < pids.length; i++) {
        const pid = Number(pids[i]);
        const st = this.pes[pid];
        if (st && st.chunks.length) this._finalize(pid, st);
      }
    }
  }

  /* ================= MP4 盒子 ================= */

  function mvhd() {
    return fullBox("mvhd", 0, 0,
      be32(0), be32(0), be32(1000), be32(0),
      be32(0x00010000), be16(0x0100), be16(0),
      zeros(8), MATRIX, zeros(24), be32(3));
  }

  function tkhd(id, isAudio, w, h) {
    return fullBox("tkhd", 0, 3,
      be32(0), be32(0), be32(id), be32(0), be32(0),
      zeros(8), be16(0), be16(0), be16(isAudio ? 0x0100 : 0), be16(0),
      MATRIX,
      be32(isAudio ? 0 : ((w * 65536) >>> 0)),
      be32(isAudio ? 0 : ((h * 65536) >>> 0)));
  }

  function mdhd(timescale) {
    return fullBox("mdhd", 0, 0, be32(0), be32(0), be32(timescale), be32(0), be16(0x55c4), be16(0));
  }

  function hdlr(type, name) {
    const n = new Uint8Array(name.length + 1);
    for (let i = 0; i < name.length; i++) n[i] = name.charCodeAt(i);
    return fullBox("hdlr", 0, 0, be32(0), fourcc(type), zeros(12), n);
  }

  function dinf() {
    return box("dinf", fullBox("dref", 0, 0, be32(1), fullBox("url ", 0, 1)));
  }

  function emptyStbl(stsd) {
    return box("stbl",
      stsd,
      fullBox("stts", 0, 0, be32(0)),
      fullBox("stsc", 0, 0, be32(0)),
      fullBox("stsz", 0, 0, be32(0), be32(0)),
      fullBox("stco", 0, 0, be32(0)));
  }

  function stsd(entry) {
    return fullBox("stsd", 0, 0, be32(1), entry);
  }

  function avc1Entry(cfg) {
    const sps = cfg.sps;
    const pps = cfg.pps;
    const avcC = box("avcC",
      new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
      be16(sps.length), sps,
      new Uint8Array([1]), be16(pps.length), pps);

    const head = concat([
      zeros(6), be16(1),
      be16(0), be16(0), zeros(12),
      be16(cfg.width), be16(cfg.height),
      be32(0x00480000), be32(0x00480000),
      be32(0), be16(1), zeros(32),
      be16(0x0018), be16(0xffff)
    ]);
    return box("avc1", head, avcC);
  }

  function desc(tag, parts) {
    const body = concat(parts);
    let len;
    if (body.length < 128) {
      len = new Uint8Array([body.length]);
    } else {
      len = new Uint8Array([0x80 | ((body.length >> 7) & 0x7f), body.length & 0x7f]);
    }
    return concat([new Uint8Array([tag]), len, body]);
  }

  function mp4aEntry(cfg) {
    const asc = new Uint8Array(2);
    asc[0] = ((cfg.aot & 0x1f) << 3) | ((cfg.sfIndex >> 1) & 0x07);
    asc[1] = ((cfg.sfIndex & 0x01) << 7) | ((cfg.channels & 0x0f) << 3);

    const dsi = desc(0x05, [asc]);
    const dcd = desc(0x04, [
      new Uint8Array([0x40, 0x15]), zeros(3), be32(128000), be32(128000), dsi
    ]);
    const sl = desc(0x06, [new Uint8Array([0x02])]);
    const es = desc(0x03, [be16(1), new Uint8Array([0]), dcd, sl]);
    const esds = fullBox("esds", 0, 0, es);

    const head = concat([
      zeros(6), be16(1),
      zeros(8),
      be16(cfg.channels || 2), be16(16), be16(0), be16(0),
      be32((cfg.sampleRate || 44100) * 65536)
    ]);
    return box("mp4a", head, esds);
  }

  function trex(id) {
    return fullBox("trex", 0, 0, be32(id), be32(1), be32(0), be32(0), be32(0));
  }

  function buildTrak(isAudio, id, cfg) {
    const tkhdBox = isAudio ? tkhd(id, true, 0, 0) : tkhd(id, false, cfg.width, cfg.height);
    const mdhdBox = mdhd(isAudio ? cfg.sampleRate : VIDEO_TS);
    const minf = isAudio
      ? box("minf",
        fullBox("smhd", 0, 0, be16(0), be16(0)),
        dinf(),
        emptyStbl(stsd(mp4aEntry(cfg))))
      : box("minf",
        fullBox("vmhd", 0, 1, be16(0), zeros(6)),
        dinf(),
        emptyStbl(stsd(avc1Entry(cfg))));
    const mdia = box("mdia", mdhdBox, hdlr(isAudio ? "soun" : "vide", isAudio ? "SoundHandler" : "VideoHandler"), minf);
    return { trak: box("trak", tkhdBox, mdia), tkhdLen: tkhdBox.length };
  }

  /**
   * 生成 init 段。同时记录 mvhd / tkhd / mdhd 里 duration 字段的绝对偏移——
   * 流式写盘时还不知道总时长，只能在收尾时回填，否则播放器会把时长显示成 0 或第一段的值。
   */
  function buildInit(videoCfg, audioCfg) {
    const ftyp = box("ftyp", fourcc("isom"), be32(512), fourcc("isom"), fourcc("iso2"), fourcc("avc1"), fourcc("mp41"));
    const mvhdBox = mvhd();
    const parts = [mvhdBox];
    const rel = [{ kind: "mvhd", at: 8 + 24 }]; // moov 头 8 字节 + mvhd 自身的 24 字节
    let p = 8 + mvhdBox.length;

    const tracks = [{ isAudio: false, id: 1, cfg: videoCfg }];
    if (audioCfg) tracks.push({ isAudio: true, id: 2, cfg: audioCfg });

    const trexs = [];
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const built = buildTrak(t.isAudio, t.id, t.cfg);
      // tkhd (trak+8) 的 duration 在 box 内 +28；mdhd (trak+8+tkhd+8) 的 duration 在 box 内 +24
      rel.push({ kind: "tkhd", track: t.id, at: p + 8 + 28 });
      rel.push({ kind: "mdhd", track: t.id, at: p + 8 + built.tkhdLen + 8 + 24 });
      parts.push(built.trak);
      p += built.trak.length;
      trexs.push(trex(t.id));
    }

    const moov = box.apply(null, ["moov"].concat(parts).concat([box("mvex", ...trexs)]));
    const init = concat([ftyp, moov]);
    const offsets = rel.map((r) => ({ kind: r.kind, track: r.track, at: ftyp.length + r.at }));
    return { init, offsets };
  }

  /* ================= 分片构建 ================= */

  function buildFrag(trackId, samples, seq, baseTime) {
    let dataLen = 0;
    let needCts = false;
    for (let i = 0; i < samples.length; i++) {
      dataLen += samples[i].data.length;
      if (samples[i].cts !== samples[i].dts) needCts = true;
    }

    const mk = (dataOffset) => {
      let flags = 0x000001 | 0x000100 | 0x000200 | 0x000400;
      if (needCts) flags |= 0x000800;
      const parts = [be32(samples.length), be32(dataOffset)];
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        parts.push(be32(s.dur || 0));
        parts.push(be32(s.data.length));
        parts.push(be32(s.key ? 0x02000000 : 0x01010000));
        if (needCts) parts.push(be32s(s.cts - s.dts));
      }
      const trun = fullBox.apply(null, ["trun", needCts ? 1 : 0, flags].concat(parts));
      return box("moof",
        fullBox("mfhd", 0, 0, be32(seq)),
        box("traf",
          fullBox("tfhd", 0, 0x020000, be32(trackId)),
          fullBox("tfdt", 1, 0, be64(baseTime)),
          trun));
    };

    const probe = mk(0);
    const moof = mk(probe.length + 8);

    const out = [moof, be32(8 + dataLen), fourcc("mdat")];
    for (let i = 0; i < samples.length; i++) out.push(samples[i].data);
    return concat(out);
  }

  function avccSample(nals, keep) {
    let size = 0;
    for (let i = 0; i < keep.length; i++) size += 4 + keep[i].length;
    const data = new Uint8Array(size);
    let o = 0;
    for (let i = 0; i < keep.length; i++) {
      const n = keep[i];
      data[o] = (n.length >>> 24) & 0xff;
      data[o + 1] = (n.length >>> 16) & 0xff;
      data[o + 2] = (n.length >>> 8) & 0xff;
      data[o + 3] = n.length & 0xff;
      data.set(n, o + 4);
      o += 4 + n.length;
    }
    return data;
  }

  /* ================= 重封装器 ================= */

  class Remuxer {
    constructor(opts) {
      opts = opts || {};
      this.onChunk = opts.onChunk || function () {};
      this.ts = new TsParser();
      this.sps = null;
      this.pps = null;
      this.width = 0;
      this.height = 0;
      this.aCfg = null;
      this.vPending = [];
      this.aPending = [];
      this.vSamples = 0;
      this.aSamples = 0;
      this.aFlushed = 0;
      this.vFirstDts = -1;
      this.aFirstPts = -1;
      this.vStart = -1;
      this.base = 0;
      this.seq = 0;
      this.headerWritten = false;
      this.started = false;
      this.lastAEnd = 0;
      this.vEnd = 0;
      this.aEnd = 0;
      this.ended = false;
      this.vWrap = { wrap: 0, last: -1 };
      this.aWrap = { wrap: 0, last: -1 };

      this.ts.onVideo = (p) => this._onVideo(p);
      this.ts.onAudio = (p) => this._onAudio(p);
    }

    push(bytes) {
      if (this.ended) return;
      this.ts.push(bytes);
      if (this.ts.error) throw new Error(this.ts.error);
    }

    flush() {
      if (this.ended) return;
      this.ended = true;
      this.ts.drain();
      if (this.ts.error) throw new Error(this.ts.error);
      if (!this.vSamples) {
        throw new Error(this.ts.scrambled ? "分片是加密 TS，无法重封装" : "没有解析到 H.264 视频帧，无法重封装");
      }
      if (this.vPending.length) this._flushVideo();
      if (this.aPending.length) this._flushAudio();
    }

    stats() {
      const dur = Math.max(this.vEnd / VIDEO_TS, this.aCfg ? this.aEnd / this.aCfg.sampleRate : 0);
      return {
        width: this.width,
        height: this.height,
        videoFrames: this.vSamples,
        audioFrames: this.aSamples,
        duration: dur,
        hasAudio: !!this.aCfg
      };
    }

    _fix(pts, dts, st) {
      let p = pts + st.wrap;
      let d = dts + st.wrap;
      if (st.last >= 0 && d < st.last - 0x10000000) {
        st.wrap += WRAP;
        p += WRAP;
        d += WRAP;
      }
      st.last = d;
      return { pts: p, dts: d };
    }

    _onVideo(pes) {
      const t = this._fix(pes.pts, pes.dts, this.vWrap);
      if (t.dts < 0) return;

      const nals = splitAnnexB(pes.data);
      if (!nals.length) return;

      let key = false;
      const keep = [];
      for (let i = 0; i < nals.length; i++) {
        const n = nals[i];
        if (!n.length) continue;
        const type = n[0] & 0x1f;
        if (type === 7) {
          if (!this.sps) {
            this.sps = n.slice();
            const dims = parseSpsDims(this.sps);
            if (dims && dims.width > 0 && dims.height > 0) {
              this.width = dims.width;
              this.height = dims.height;
            }
          }
          continue;
        }
        if (type === 8) {
          if (!this.pps) this.pps = n.slice();
          continue;
        }
        if (type === 9) continue; // 访问单元分隔符，MP4 里不需要
        if (type === 5) key = true;
        keep.push(n);
      }
      if (!keep.length) return;

      // 首个关键帧之前的帧解不出来，直接丢掉，避免 MP4 第一段是花屏
      if (!this.started) {
        if (!key) return;
        this.started = true;
      }

      if (this.vFirstDts < 0) this.vFirstDts = t.dts;
      if (this.vStart < 0) this.vStart = t.dts;

      const sample = { dts: t.dts, cts: t.pts, data: avccSample(nals, keep), key };
      if (key && this.vPending.length) this._flushVideo();
      this.vPending.push(sample);
      this.vSamples++;
    }

    _onAudio(pes) {
      const t = this._fix(pes.pts, pes.dts, this.aWrap);
      let buf = pes.data;
      if (this.aRest && this.aRest.length) {
        buf = concat([this.aRest, buf]);
        this.aRest = null;
      }

      let off = 0;
      while (off + 7 <= buf.length) {
        const h = parseAdts(buf, off);
        if (!h || off + h.frameLen > buf.length) break;
        if (!this.aCfg) {
          this.aCfg = {
            aot: h.profile + 1,
            sfIndex: h.sfIndex,
            channels: h.channels || 2,
            sampleRate: SAMPLE_RATES[h.sfIndex]
          };
        }
        if (this.aFirstPts < 0) this.aFirstPts = t.pts;
        this.aPending.push({ data: buf.slice(off + h.hdrLen, off + h.frameLen), dur: h.samples, key: true, dts: 0, cts: 0 });
        this.aSamples++;
        off += h.frameLen;
      }
      if (off < buf.length) this.aRest = buf.slice(off);
    }

    _flushVideo() {
      const batch = this.vPending;
      this.vPending = [];
      if (!batch.length) return;

      if (!this.headerWritten) {
        if (!this.sps || !this.pps || !this.width) throw new Error("缺少 SPS/PPS，无法重封装");
        this._writeHeader();
      }

      let lastDur = 3000;
      for (let i = 0; i < batch.length; i++) {
        let dur;
        if (i + 1 < batch.length) dur = batch[i + 1].dts - batch[i].dts;
        else dur = lastDur;
        if (!(dur > 0) || dur > 900000) dur = lastDur;
        batch[i].dur = dur;
        lastDur = dur;
      }

      const tf = Math.round(batch[0].dts - this.base);
      this.onChunk(buildFrag(1, batch, ++this.seq, tf));
      this.vEnd = tf + batch.reduce((a, s) => a + s.dur, 0);
      this.lastVEnd = this.vEnd;

      if (this.aPending.length) this._flushAudio();
    }

    _flushAudio() {
      const batch = this.aPending;
      this.aPending = [];
      if (!batch.length || !this.aCfg) return;

      const sr = this.aCfg.sampleRate;
      const frames = this.aFlushed;
      const pts90 = this.aFirstPts + (frames * 1024 * VIDEO_TS) / sr;
      let tf = Math.round(((pts90 - this.base) * sr) / VIDEO_TS);
      if (tf < this.lastAEnd) tf = this.lastAEnd;
      if (tf < 0) tf = 0;

      this.onChunk(buildFrag(2, batch, ++this.seq, tf));
      this.aEnd = tf + batch.reduce((a, s) => a + s.dur, 0);
      this.lastAEnd = this.aEnd;
      this.aFlushed += batch.length;
    }

    _writeHeader() {
      const anchors = [];
      if (this.vFirstDts >= 0) anchors.push(this.vFirstDts);
      if (this.aFirstPts >= 0) anchors.push(this.aFirstPts);
      this.base = anchors.length ? Math.min.apply(null, anchors) : 0;

      const videoCfg = { sps: this.sps, pps: this.pps, width: this.width, height: this.height };
      const built = buildInit(videoCfg, this.aCfg);
      this.patchOffsets = built.offsets;
      this.onChunk(built.init);
      this.headerWritten = true;
    }

    /** 收尾时才知道总时长：返回要回填到 mvhd/tkhd/mdhd 的 4 字节大端值 */
    patchBytes() {
      if (!this.patchOffsets || !this.headerWritten) return [];
      const movieScale = 1000;
      const vMovies = Math.round((this.vEnd * movieScale) / VIDEO_TS);
      const aMovies = this.aCfg ? Math.round((this.aEnd * movieScale) / this.aCfg.sampleRate) : 0;
      const out = [];
      for (let i = 0; i < this.patchOffsets.length; i++) {
        const o = this.patchOffsets[i];
        let v = 0;
        if (o.kind === "mvhd") v = Math.max(vMovies, aMovies);
        else if (o.kind === "tkhd") v = o.track === 1 ? vMovies : aMovies;
        else if (o.kind === "mdhd") v = o.track === 1 ? this.vEnd : this.aEnd;
        out.push({ at: o.at, bytes: be32(Math.max(0, Math.round(v))) });
      }
      return out;
    }
  }

  /* ================= 探测 ================= */

  function typeName(t) {
    if (t === 0x1b) return "avc";
    if (t === 0x24 || t === 0x27) return "hevc";
    if (t === 0x0f) return "aac";
    if (t === 0x03 || t === 0x04) return "mp3";
    if (t < 0) return "unknown";
    if (t) return "other";
    return null;
  }

  /** 只解析出流类型，用来决定「值不值得重封装」，不产生任何输出 */
  function probe(bytes) {
    const p = new TsParser();
    try {
      p.push(bytes);
    } catch (e) {
      return { video: null, audio: null, scrambled: false, error: String(e && e.message) };
    }
    return {
      video: typeName(p.videoType),
      audio: typeName(p.audioType),
      scrambled: p.scrambled,
      error: p.error || null
    };
  }

  return { Remuxer, probe, TsParser, splitAnnexB, parseSpsDims, parseAdts, SAMPLE_RATES };
});
