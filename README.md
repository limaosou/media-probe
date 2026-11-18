# 探源 · 视频嗅探下载器

Chrome / Edge 扩展（Manifest V3，`minimum_chrome_version` 116）。嗅探当前网页中**可公开访问**的视频与图片资源，多路同时探测、勾选批量下载；HLS（`.m3u8`）按页面累积的完整分片合并，并直接重封装成可播放的 MP4。

> **能力边界**
> 只读取「浏览器本身已经成功请求过」的媒体地址，不做任何解密或破解。
> 页面使用 DRM（Widevine / PlayReady / FairPlay）时，扩展主动拒绝并在弹窗顶栏提示。
> 需要付费或登录后才能获取的内容不在支持范围内 —— 那属于规避技术保护措施。

---

## 安装

**方式一 · 下载安装包（推荐）**

到 [Releases](../../releases/latest) 下载 `media-probe-v1.7.0.zip`，解压到固定目录（如 `D:\ext\media-probe`），然后：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选中解压后的目录
4. 把图标固定到工具栏

> 扩展尚未上架应用商店，只能通过开发者模式安装。装一次即可，之后更新代码不需要再点这个页面的刷新。

**方式二 · 从源码加载**

```bash
git clone https://github.com/limaosou/media-probe.git
```

然后在 `chrome://extensions` 里「加载已解压的扩展程序」，选中仓库根目录。

---

## 使用

1. 在网页上**正常播放**视频 —— 嗅探依赖真实发生的请求
2. 点扩展图标，弹出资源列表，图标角标是本页可下载条目数
3. 用顶部标签筛选：**全部 / 当前播放 / HLS / 直链 / 分片**
   - 「当前播放」是自动判定出的此刻页面上正在播的那一条
   - 分片（`.ts`、`.m4s`）默认折叠，避免一个 HLS 页面刷出几百条
4. 勾选要的条目 → 底部「下载选中 (N)」
   - 直链：批量提交给浏览器下载管理器
   - HLS：只开一个下载页，选中的地址排队依次合并，结果直接是 MP4
5. 「智能选择」= 勾选全部 HLS + 每个域名下体积最大的直链
6. 单条右侧的「下载 / 复制」可以单独处理一条

### 视频探测不到的常见原因

播放器拿地址的方式不止 `<video src>` 一种。以下情况本扩展都已覆盖：

| 取值方式 | 处理 |
| --- | --- |
| `fetch('/api/play?id=...')`，地址没有 `.m3u8` 后缀 | hook `fetch`，按响应正文里的 `#EXTM3U` 识别 |
| `XMLHttpRequest` | hook XHR |
| 列表伪装成 `text/plain` / `json` / `octet-stream` | 按地址关键词 + 正文判断 |
| 扩展装上之前就已加载完的资源 | `performance` resource timing 补扫 |
| 相对地址（`/api/play?…`） | 先补全为绝对地址 |
| `<video>` 在 iframe 里 | 所有 frame 都注入 |

注入脚本以 `world: "MAIN"` 在 `document_start` 运行，比页面脚本更早，不会漏掉一打开就发出的第一批请求。

### 热更新

`rules.json`（域名规则）、`ui.js` / `ui.css`（界面）改动后不需要在扩展页点刷新，重新打开弹窗即生效。

---

## 已知问题

- `chrome://extensions` 里出现红色 `Extension context invalidated`：扩展重载后，**已经打开的标签页**里跑的还是旧脚本。把那个页面刷新一下即可，功能没有受影响。
- 部分站点的 HLS 分片带鉴权参数、且参数会过期。合并必须在同一个会话内完成，隔太久再合并会失败。

---

## 隐私

扩展不收集、不上传任何数据。嗅探结果只存在浏览器本地（`chrome.storage.local`），下载直接走浏览器下载管理器。

---

## 许可

[MIT](LICENSE) © 2026 狸猫

第三方组件：[hls.js](https://github.com/video-dev/hls.js/)（Apache-2.0），用于 HLS 分片解析。
