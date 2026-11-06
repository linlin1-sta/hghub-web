// HGhub 网页版服务端：把 Tauri 客户端的 Rust 后端等价搬到 Node（零依赖，Node >= 18）。
//
// 对应关系（与 src-tauri 一一对应，逻辑按源码直译）：
//   net.rs     → edge() 边缘信封 / fetchBytes() / diagnose()
//   lines.rs   → fixedLines / mirrors() / probe()
//   media.rs   → 封面 AES 解密 / HLS 改写 / 媒体缓存（/media/img|hls|seg）
//   api.rs     → COMMANDS 命令分发（/bridge/invoke）
//   session.rs → 浏览器会话（cookie → {token, user, base}，落盘 data/sessions.json）
//
// 额外：静态托管前端 dist/、访问口令门（环境变量 ACCESS_TOKEN，可选但强烈建议设）。

import http from "node:http";
import { createHash, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "web", "data");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || "").trim();

let APP_VERSION = "1.1.0";
try {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  if (pkg.version) APP_VERSION = String(pkg.version);
} catch { /* 用默认版本 */ }

/* ───────────────────────── net.rs ───────────────────────── */

const DEFAULT_BASE = "https://huangguoai.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function normalizeBase(url) {
  try {
    const u = new URL(String(url || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.host) return null;
    return String(url).trim().replace(/\/+$/, "");
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errText(e) {
  const parts = [];
  let cur = e;
  while (cur) {
    const t = cur.message || String(cur);
    if (t && !parts.includes(t)) parts.push(t);
    cur = cur.cause;
  }
  return parts.join(" ← ");
}

async function withRetry(fn) {
  let last = "network error";
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fn(); }
    catch (e) {
      last = e instanceof Error ? e.message : String(e);
      if (attempt < 2) await sleep(350 * (attempt + 1));
    }
  }
  throw new Error(last);
}

async function edge(sess, method, path_, body, token) {
  const encoded = body != null ? Buffer.from(JSON.stringify(body), "utf8").toString("base64") : "";
  const envelope = { method, path: path_, body: encoded, content_type: body != null ? "application/json" : "" };
  const base = sess.base;
  const text = await withRetry(async () => {
    const headers = { Accept: "application/json", Referer: `${base}/`, "User-Agent": UA, "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const resp = await fetch(`${base}/api/edge/request`, {
      method: "POST", headers, body: JSON.stringify(envelope), signal: AbortSignal.timeout(20000),
    });
    const t = await resp.text();
    if (resp.status === 401 || resp.status === 403) throw new Error("401");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${t.slice(0, 160)}`);
    return t;
  }).catch((e) => { throw new Error(errText(e)); });
  if (!text.trim()) return null;
  let value;
  try { value = JSON.parse(text); } catch (e) { throw new Error(`${e.message}: ${text.slice(0, 160)}`); }
  if (value == null) return null;
  if (value.status === 1) return value.data ?? null;
  throw new Error((typeof value.msg === "string" && value.msg) || "接口返回失败");
}

async function fetchBytes(sess, url) {
  return withRetry(async () => {
    const resp = await fetch(url, {
      headers: { Referer: `${sess.base}/`, "User-Agent": UA }, signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    return { contentType: resp.headers.get("content-type"), bytes: buf };
  }).catch((e) => { throw new Error(errText(e)); });
}

async function fetchText(url, timeoutMs = 12000) {
  const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

/* ───────────────────────── lines.rs ───────────────────────── */

const FIXED_LINES = [
  { name: "固定线路 1", url: "https://huangguoai.com" },
  { name: "固定线路 2", url: "https://huangguoai.ai" },
];
const PUBLISH_PAGE = "https://huangguoai.pages.dev/";
const MIRROR_MAX = 60;

function stripLineComments(body) {
  let out = "";
  let quote = null;
  const chars = [...body];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c; out += c;
    } else if (c === "/" && chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n") i++;
      if (i < chars.length) out += "\n";
    } else out += c;
  }
  return out;
}

function jsArray(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) return [];
  const rest = src.slice(at);
  const open = rest.indexOf("[");
  if (open < 0) return [];
  const close = rest.slice(open).indexOf("]");
  if (close < 0) return [];
  return stripLineComments(rest.slice(open + 1, open + close))
    .split(",")
    .map((raw) => raw.trim().replace(/^['"]+|['"]+$/g, "").trim())
    .filter(Boolean);
}

function scriptSrc(html) {
  let rest = html;
  for (;;) {
    const i = rest.indexOf('src="');
    if (i < 0) return null;
    const after = rest.slice(i + 5);
    const end = after.indexOf('"');
    if (end < 0) return null;
    const candidate = after.slice(0, end);
    if (candidate.includes(".js")) return candidate;
    rest = after.slice(end);
  }
}

function absoluteUrl(base, rel) {
  if (rel.startsWith("http://") || rel.startsWith("https://")) return rel;
  try {
    const u = new URL(base);
    const origin = `${u.protocol}//${u.host}`;
    return rel.startsWith("/") ? `${origin}${rel}` : `${origin}/${rel}`;
  } catch { return rel; }
}

async function mirrors() {
  const html = await fetchText(PUBLISH_PAGE);
  const jsRel = scriptSrc(html) || "publish.js";
  const jsUrl = absoluteUrl(PUBLISH_PAGE, jsRel);
  const js = await fetchText(jsUrl);
  const domains = jsArray(js, "var urls");
  const subs = jsArray(js, "var subdomains");
  if (!domains.length) throw new Error("地址发布页格式有变化：没找到镜像域名");
  const items = [];
  const seen = new Set();
  outer: for (const rawDomain of domains) {
    const domain = rawDomain.replace(/\/+$/, "");
    if (!domain) continue;
    const hosts = subs.length ? subs.map((s) => `${s}.${domain}`) : [domain];
    for (const host of hosts) {
      if (seen.has(host)) continue;
      seen.add(host);
      items.push({ url: `https://${host}`, host });
      if (items.length >= MIRROR_MAX) break outer;
    }
  }
  if (!items.length) throw new Error("地址发布页里没有可用的镜像地址");
  return { source: PUBLISH_PAGE, script: jsUrl, items };
}

async function probeOne(url) {
  const target = `${url.replace(/\/+$/, "")}/`;
  const started = Date.now();
  try {
    const resp = await fetch(target, {
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    await resp.arrayBuffer().catch(() => {});
    return { url, ok: resp.status < 400, status: resp.status, ms: Date.now() - started };
  } catch (e) {
    return { url, ok: false, ms: Date.now() - started, error: errText(e) };
  }
}

async function probe(urls) {
  const out = [];
  for (let i = 0; i < urls.length; i += 6) {
    out.push(...await Promise.all(urls.slice(i, i + 6).map(probeOne)));
  }
  return out;
}

/* ───────────────────────── media.rs ───────────────────────── */

const IMG_KEY = Buffer.from("f5d965df75336270", "utf8");
const IMG_IV = Buffer.from("97b60394abc2fbe1", "utf8");

function cachePut(map, key, val, max) {
  if (map.size >= max && !map.has(key)) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, val);
}
const imgCache = new Map();
const plCache = new Map();

function imageKind(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

function aesCbcDecrypt(data) {
  if (!data.length || data.length % 16 !== 0) return null;
  try {
    const d = createDecipheriv("aes-128-cbc", IMG_KEY, IMG_IV);
    return Buffer.concat([d.update(data), d.final()]);
  } catch { return null; }
}

async function loadImage(sess, url) {
  const hit = imgCache.get(url);
  if (hit) return { kind: imageKind(hit) || "image/jpeg", bytes: hit };
  const { bytes } = await fetchBytes(sess, url);
  let plain = bytes;
  if (!imageKind(bytes)) {
    const dec = aesCbcDecrypt(bytes);
    if (!dec) throw new Error("封面解密失败");
    plain = dec;
  }
  const kind = imageKind(plain) || "image/jpeg";
  cachePut(imgCache, url, plain, 240);
  return { kind, bytes: plain };
}

// 与 Rust percent_encoding::NON_ALPHANUMERIC 一致：只保留字母数字，其余全编码
function enc(s) {
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  for (const b of bytes) {
    const isAlnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
    out += isAlnum ? String.fromCharCode(b) : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}
function dec(s) {
  try { return decodeURIComponent(s.replace(/\+/g, "%20")); } catch { return s; }
}

function absolutize(base, target) {
  if (target.startsWith("http://") || target.startsWith("https://")) return target;
  try { return new URL(target, base).toString(); } catch { return target; }
}

function rewriteUriAttr(line, prefix) {
  const start = line.indexOf('URI="');
  if (start < 0) return line;
  const rest = line.slice(start + 5);
  const end = rest.indexOf('"');
  if (end < 0) return line;
  const uri = rest.slice(0, end);
  return `${line.slice(0, start + 5)}${prefix}/seg?u=${enc(uri)}${rest.slice(end)}`;
}

function absolutizeUriInAttr(base, line) {
  const start = line.indexOf('URI="');
  if (start < 0) return line;
  const rest = line.slice(start + 5);
  const end = rest.indexOf('"');
  if (end < 0) return line;
  const abs = absolutize(base, rest.slice(0, end));
  return `${line.slice(0, start + 5)}${abs}${rest.slice(end)}`;
}

async function loadPlaylist(sess, url, prefix) {
  const hit = plCache.get(url);
  if (hit) return hit;
  const { bytes } = await fetchBytes(sess, url);
  const text = bytes.toString("utf8");
  let out = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) { out += "\n"; continue; }
    if (line.startsWith("#")) {
      if (line.startsWith("#EXT-X-KEY") || line.startsWith("#EXT-X-MAP")) {
        out += rewriteUriAttr(absolutizeUriInAttr(url, line), prefix);
      } else out += line;
    } else {
      out += `${prefix}/seg?u=${enc(absolutize(url, line))}`;
    }
    out += "\n";
  }
  cachePut(plCache, url, out, 60);
  return out;
}

function mediaResponse(res, status, ctype, body, cache) {
  res.writeHead(status, {
    "Content-Type": ctype,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": cache,
  });
  res.end(body);
}

async function handleMedia(sess, req, res, pathname, query) {
  const target = dec((query.match(/(?:^|&)u=([^&]*)/) || [])[1] || "");
  // 网页模式的媒体前缀就是本站 /media，改写进 m3u8 的分片地址用相对前缀即可跨域名/端口
  const prefix = "/media";
  if (!target) return mediaResponse(res, 400, "text/plain", "missing u", "no-store");
  try {
    if (pathname === "/media/img") {
      const { kind, bytes } = await loadImage(sess, target);
      return mediaResponse(res, 200, kind, bytes, "public, max-age=86400");
    }
    if (pathname === "/media/hls") {
      const text = await loadPlaylist(sess, target, prefix);
      return mediaResponse(res, 200, "application/vnd.apple.mpegurl", text, "no-store");
    }
    if (pathname === "/media/seg") {
      const { contentType, bytes } = await fetchBytes(sess, target);
      return mediaResponse(res, 200, contentType || "application/octet-stream", bytes, "public, max-age=3600");
    }
    return mediaResponse(res, 404, "text/plain", "not found", "no-store");
  } catch (e) {
    return mediaResponse(res, 502, "text/plain", e.message || String(e), "no-store");
  }
}

/* ───────────────────────── session.rs（网页版：按浏览器 cookie 分会话） ───────────────────────── */

const sessions = new Map(); // sid -> { token, user, base }
const SESSION_FILE = () => path.join(DATA_DIR, "sessions.json");

async function loadSessions() {
  try {
    const obj = JSON.parse(await readFile(SESSION_FILE(), "utf8"));
    for (const [sid, s] of Object.entries(obj)) {
      sessions.set(sid, { token: s.token || "", user: s.user ?? null, base: normalizeBase(s.base) || DEFAULT_BASE });
    }
  } catch { /* 首次运行无文件 */ }
}

let saveTimer = null;
function persistSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(SESSION_FILE(), JSON.stringify(Object.fromEntries(sessions)), "utf8");
    } catch (e) { console.error("[session] 落盘失败:", e.message); }
  }, 200);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function getSession(req, res) {
  const cookies = parseCookies(req);
  let sid = cookies.hghub_sess;
  if (!sid || !sessions.has(sid)) {
    sid = randomBytes(24).toString("hex");
    sessions.set(sid, { token: "", user: null, base: DEFAULT_BASE });
    persistSessions();
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `hghub_sess=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000${secure}`);
  }
  return sessions.get(sid);
}

/* ───────────────────────── api.rs（命令分发） ───────────────────────── */

function verParts(v) {
  return String(v).trim().replace(/^[vV]/, "").split(/[.\-+]/).map((s) => Number.parseInt(s.trim(), 10) || 0);
}
function isNewer(latest, current) {
  const a = verParts(latest), b = verParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function diagnose(sess) {
  let host = "";
  try { host = new URL(sess.base).hostname; } catch { /* ignore */ }
  let dnsResult;
  try {
    const records = await dns.lookup(host, { all: true });
    dnsResult = records.map((r) => r.address);
  } catch (e) { dnsResult = `解析失败: ${e.message}`; }
  const started = Date.now();
  let httpResult;
  try {
    const resp = await fetch(`${sess.base}/`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
    httpResult = { status: resp.status, ms: Date.now() - started };
  } catch (e) { httpResult = { error: errText(e), ms: Date.now() - started }; }
  return {
    base: sess.base, host, dns: dnsResult, http: httpResult,
    env: {
      HTTP_PROXY: process.env.HTTP_PROXY || null,
      HTTPS_PROXY: process.env.HTTPS_PROXY || null,
      ALL_PROXY: process.env.ALL_PROXY || null,
      NO_PROXY: process.env.NO_PROXY || null,
      HGHUB_PROXY: process.env.HGHUB_PROXY || null,
    },
  };
}

const COMMANDS = {
  async debug_log(_sess, args) { console.log("[client]", String(args.msg ?? "")); return null; },
  async net_diag(sess) { return diagnose(sess); },

  async line_state(sess) { return { base: sess.base, default: DEFAULT_BASE, fixed: FIXED_LINES }; },
  async line_set(sess, args) {
    const next = normalizeBase(args.url);
    if (!next) throw new Error("线路地址无效（需要 http(s)://域名）");
    sess.base = next; persistSessions();
    return next;
  },
  async line_mirrors() { return mirrors(); },
  async line_probe(_sess, args) { return probe(Array.isArray(args.urls) ? args.urls.map(String) : []); },

  async check_update() {
    const current = APP_VERSION;
    const resp = await fetch(`https://api.github.com/repos/Minireel/HGhub/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": UA }, signal: AbortSignal.timeout(12000),
    }).catch((e) => { throw new Error(errText(e)); });
    if (resp.status === 404) {
      return { current, latest: "", has_update: false, url: "https://github.com/Minireel/HGhub/releases" };
    }
    if (!resp.ok) throw new Error(`GitHub 返回 HTTP ${resp.status}`);
    const v = await resp.json();
    const tag = v.tag_name || "";
    return {
      current,
      latest: tag.replace(/^[vV]/, ""),
      tag,
      has_update: !!tag && isNewer(tag, current),
      url: v.html_url || "https://github.com/Minireel/HGhub/releases",
      name: v.name || "",
      published_at: v.published_at || "",
      notes: String(v.body || "").slice(0, 800),
    };
  },

  // 网页版由前端直接 window.open，这里的实现仅作兜底校验
  async open_url(_sess, args) {
    const url = String(args.url || "");
    if (!url.startsWith("https://") && !url.startsWith("http://")) throw new Error("只允许打开 http(s) 链接");
    return null;
  },

  async app_boot(sess) {
    return { user: sess.user ?? null, logged_in: !!sess.token, base: sess.base };
  },
  async api_login(sess, args) {
    const data = await edge(sess, "POST", "/api/account/loginByPassword",
      { username: args.username, password: args.password }, null);
    const token = data?.token;
    if (typeof token !== "string" || !token) throw new Error("登录返回缺少 token");
    sess.token = token; sess.user = data.user ?? null; persistSessions();
    return { user: sess.user };
  },
  async api_register(sess, args) {
    const body = { username: args.username, password: args.password, confirm_password: args.password };
    if (typeof args.email === "string" && args.email.trim()) body.email = args.email;
    const data = await edge(sess, "POST", "/api/account/registerByPassword", body, null);
    const token = data?.token;
    if (typeof token !== "string" || !token) throw new Error("注册返回缺少 token");
    sess.token = token; sess.user = data.user ?? null; persistSessions();
    return { user: sess.user };
  },
  async api_logout(sess) {
    if (sess.token) { try { await edge(sess, "POST", "/api/account/logout", null, sess.token); } catch { /* 与 Rust 版一致：忽略错误 */ } }
    sess.token = ""; sess.user = null; persistSessions();
    return { ok: true };
  },
  async api_me(sess) {
    const me = await edge(sess, "GET", "/api/account/me", null, sess.token || null);
    if (sess.token) { sess.user = me; persistSessions(); }
    return me;
  },

  async api_feed(sess, a) { return edge(sess, "GET", `/api/videos?page=${a.page}&size=${a.size}`, null, sess.token || null); },
  async api_category(sess, a) { return edge(sess, "GET", `/api/videos/category/${a.cate}?page=${a.page}&size=${a.size}`, null, sess.token || null); },
  async api_rank(sess, a) {
    const kind = a.kind === "recommend" || a.kind === "potential" ? a.kind : "hot";
    return edge(sess, "GET", `/api/ranks/${kind}`, null, sess.token || null);
  },
  async api_search(sess, a) {
    return edge(sess, "GET", `/api/search?q=${encodeURIComponent(a.q ?? "")}&page=${a.page}&size=${a.size}`, null, sess.token || null);
  },
  async api_posts(sess, a) { return edge(sess, "GET", `/api/posts?page=${a.page}&size=${a.size}`, null, sess.token || null); },
  async api_post(sess, a) { return edge(sess, "GET", `/api/posts/${a.id}`, null, sess.token || null); },
  async api_video(sess, a) { return edge(sess, "GET", `/api/videos/${a.id}`, null, sess.token || null); },
  async api_play(sess, a) { return edge(sess, "GET", `/api/videos/${a.id}/play?ep=${a.ep}&page_texts=0`, null, sess.token || null); },
  async api_comments(sess, a) { return edge(sess, "GET", `/api/videos/${a.id}/comments?ep=${a.ep}&page=${a.page}&size=${a.size}`, null, sess.token || null); },
  async api_post_comments(sess, a) { return edge(sess, "GET", `/api/posts/${a.id}/comments?page=${a.page}&size=${a.size}`, null, sess.token || null); },

  async api_comment_send(sess, a) {
    if (!sess.token) throw new Error("请先登录");
    const body = { text: a.text };
    let path_;
    if (typeof a.replyId === "number" && a.replyId > 0) {
      body.reply_id = a.replyId;
      path_ = `/api/videos/${a.id}/comments`;
    } else {
      path_ = `/api/videos/${a.id}/comments?ep=${a.ep}`;
    }
    return edge(sess, "POST", path_, body, sess.token);
  },
  async api_like(sess, a) {
    if (!sess.token) throw new Error("请先登录");
    return edge(sess, a.on ? "POST" : "DELETE", `/api/videos/${a.id}/like?ep=${a.ep}`, null, sess.token);
  },
  async api_collect(sess, a) {
    if (!sess.token) throw new Error("请先登录");
    return edge(sess, a.on ? "POST" : "DELETE", `/api/videos/${a.id}/collect`, null, sess.token);
  },
  async api_follow(sess, a) {
    if (!sess.token) throw new Error("请先登录");
    return edge(sess, a.on ? "POST" : "DELETE", `/api/users/${a.uid}/follow`, null, sess.token);
  },
  async api_post_like(sess, a) {
    if (!sess.token) throw new Error("请先登录");
    return edge(sess, a.on ? "POST" : "DELETE", `/api/posts/${a.id}/like`, null, sess.token);
  },
  async api_post_collect(sess, a) {
    if (!sess.token) throw new Error("请先登录");
    return edge(sess, a.on ? "POST" : "DELETE", `/api/posts/${a.id}/collect`, null, sess.token);
  },

  async cache_clear() { imgCache.clear(); plCache.clear(); return null; },
};

/* ───────────────────────── HTTP 层 ───────────────────────── */

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".webp": "image/webp",
};

const gateHash = ACCESS_TOKEN ? createHash("sha256").update(ACCESS_TOKEN).digest("hex") : null;

function gateOk(req, url) {
  if (!gateHash) return true;
  if (url.searchParams.get("key") === ACCESS_TOKEN) return "set";
  return parseCookies(req).hghub_gate === gateHash;
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!rel) rel = "index.html";
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end("forbidden"); }
  try {
    const st = await stat(file);
    if (st.isDirectory()) file = path.join(file, "index.html");
  } catch {
    // SPA 兜底：无扩展名的路径回 index.html；带扩展名的当真 404
    if (path.extname(rel)) { res.writeHead(404); return res.end("not found"); }
    file = path.join(DIST, "index.html");
  }
  const ext = path.extname(file).toLowerCase();
  const isIndex = path.basename(file) === "index.html";
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": isIndex ? "no-cache" : "public, max-age=604800, immutable",
  });
  createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 2 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

await loadSessions();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    // 访问口令门
    const gate = gateOk(req, url);
    if (gate === "set") {
      const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      res.setHeader("Set-Cookie", `hghub_gate=${gateHash}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
      url.searchParams.delete("key");
      res.writeHead(302, { Location: url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : "") });
      return res.end();
    }
    if (gate !== true) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<meta charset=utf-8><title>HGhub</title><p style='font-family:sans-serif;padding:2em'>需要访问口令：在地址后加上 <code>?key=你的口令</code> 打开一次即可。</p>");
    }

    if (pathname === "/bridge/invoke" && req.method === "POST") {
      const sess = getSession(req, res);
      let payload;
      try { payload = JSON.parse(await readBody(req)); } catch { payload = null; }
      const cmd = payload?.cmd;
      const args = payload?.args ?? {};
      const fn = COMMANDS[cmd];
      res.setHeader("Content-Type", "application/json");
      if (!fn) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: `unknown command: ${cmd}` })); }
      try {
        const data = await fn(sess, args);
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, data: data ?? null }));
      } catch (e) {
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
      }
    }

    if (pathname.startsWith("/media/")) {
      const sess = getSession(req, res);
      const query = url.search.slice(1);
      return await handleMedia(sess, req, res, pathname, query);
    }

    if (req.method === "GET" || req.method === "HEAD") return await serveStatic(req, res, pathname);
    res.writeHead(405); return res.end("method not allowed");
  } catch (e) {
    console.error("[http]", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("server error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`HGhub web 已启动: http://${HOST}:${PORT}  (版本 ${APP_VERSION}, 口令门 ${ACCESS_TOKEN ? "开" : "关"})`);
});
