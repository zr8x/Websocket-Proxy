#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFile } = require("child_process");
const { WebSocketServer } = require("ws");
const { URL } = require("url");

const YTDLP = fs.existsSync(path.join(__dirname, ".venv", "bin", "yt-dlp"))
  ? path.join(__dirname, ".venv", "bin", "yt-dlp")
  : "yt-dlp";

const HAS_CURL_CFFI = (() => {
  for (const py of [path.join(__dirname, ".venv", "bin", "python"), "python3"]) {
    try {
      if (spawnSync(py, ["-c", "import curl_cffi"], { timeout: 8000 }).status === 0) return true;
    } catch {}
  }
  return false;
})();

const YT_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), "wspxy-yt-"));

const PORT = Number(process.env.PORT) || 8080;
const PROXY = "proxy://";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

const INJECT = fs.readFileSync(path.join(__dirname, "inject.js"), "utf8");

let OPENAI_KEY = process.env.OPENAI_API_KEY || "";

const wss = new WebSocketServer({ port: PORT });
wss.on("listening", () => {
  console.log(`[proxy] WebSocket proxy listening on ws://localhost:${PORT}`);
});

function absUrl(base, ref) {
  try {
    return new URL(String(ref).trim(), base).href;
  } catch {
    return null;
  }
}

function isSpecial(u) {
  return /^(proxy:\/\/|#|javascript:|data:|mailto:|tel:|sms:|about:|blob:|file:|ws:|wss:|chrome:|chrome-extension:|vbscript:|cid:)/i.test(u);
}

function rewriteUrl(base, raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (isSpecial(s)) return null;
  const abs = absUrl(base, s);
  if (!abs) return null;
  if (abs.startsWith("http:") || abs.startsWith("https:")) return PROXY + abs;
  return null;
}

function rewriteAttrs(html, base) {
  let out = html;
  for (const attr of ["href", "src", "action", "poster", "data-src"]) {
    const re = new RegExp("\\b" + attr + "\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", "gi");
    out = out.replace(re, (m, v) => {
      let q = "";
      let raw = v;
      if (v[0] === '"' || v[0] === "'") {
        q = v[0];
        raw = v.slice(1, -1);
      }
      const rw = rewriteUrl(base, raw);
      if (rw === null) return m;
      return attr + "=" + q + rw + q;
    });
  }
  return out;
}

function rewriteSrcset(html, base) {
  const re = /\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi;
  return html.replace(re, (m, full, d1, d2) => {
    const v = d1 !== undefined ? d1 : d2;
    const parts = v.split(",").map((p) => p.trim()).filter(Boolean);
    let changed = false;
    const out = parts.map((p) => {
      const toks = p.split(/\s+/);
      const rw = rewriteUrl(base, toks[0]);
      if (rw === null) return p;
      changed = true;
      return rw + (toks[1] ? " " + toks[1] : "");
    });
    return changed ? `srcset="${out.join(", ")}"` : m;
  });
}

function stripBaseAndCsp(html) {
  let out = html.replace(/<base\b[^>]*>/gi, "");
  out = out.replace(/<meta\b[^>]*>/gi, (mm) => {
    if (/http-equiv\s*=\s*["']?\s*(?:content-security-policy|refresh)["']?/i.test(mm)) return "";
    return mm;
  });
  return out;
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].trim() : "";
}

function rewriteHtml(html, base) {
  let out = html;
  out = stripBaseAndCsp(out);
  out = rewriteAttrs(out, base);
  out = rewriteSrcset(out, base);
  const script = "\n<script>\n" + INJECT + "\n</script>\n";
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, script + "</body>");
  } else if (/<\/html>/i.test(out)) {
    out = out.replace(/<\/html>/i, script + "</html>");
  } else {
    out += script;
  }
  return { html: out, title: extractTitle(out) };
}

async function fetchUrl(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      method: opts.method || "GET",
      body: opts.body || undefined,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": opts.method === "POST" ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        ...(opts.method === "POST" ? { "Content-Type": opts.contentType || "application/x-www-form-urlencoded" } : {}),
      },
    });
    if (!res.ok && res.status !== 304) {
      throw new Error("HTTP " + res.status);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "";
    return { status: res.status, contentType, finalUrl: res.url, body: buf };
  } finally {
    clearTimeout(timer);
  }
}

function baseOf(url) {
  try {
    const u = new URL(url);
    return u.protocol + "//" + u.host;
  } catch {
    return url;
  }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function fmtDur(s) {
  s = Math.round(Number(s) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
}

function classifyYt(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./i, "");
  if (host !== "youtube.com" && host !== "youtu.be") return null;
  if (host === "youtu.be") return null;
  const p = u.pathname;
  if (p === "/" || p === "") return { kind: "home" };
  if (/^\/results\/?$/.test(p) && u.searchParams.get("search_query"))
    return { kind: "search", query: u.searchParams.get("search_query") };
  if (/^\/playlist\/?$/.test(p)) return { kind: "list", url: urlStr, title: "Playlist" };
  if (/^\/(?:@[\w.-]+|channel\/[\w-]+|user\/[\w-]+)(?:\/|$)/.test(p))
    return { kind: "list", url: urlStr, title: "Channel" };
  return null;
}

async function ytRunFlat(args) {
  const raw = await ytRun(args, 16 * 1024 * 1024);
  return JSON.parse(raw);
}

async function gridFromSearch(query) {
  const j = await ytRunFlat(["--flat-playlist", "-J", "ytsearch20:" + query]);
  return (j.entries || []).filter((e) => e.id && e.title);
}

async function gridFromList(url) {
  const j = await ytRunFlat(["--flat-playlist", "-I", "1:50", "-J", url]);
  return (j.entries || []).filter((e) => e.id);
}

async function gridFromHome() {
  const queries = ["music", "news", "technology", "science", "comedy", "sports"];
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    try {
      const items = await gridFromSearch(q);
      for (const it of items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it);
        if (out.length >= 36) return out;
      }
    } catch (err) {
      console.log("[yt] home search '" + q + "' failed:", err.message);
    }
  }
  return out;
}

function ytPageHTML(opts) {
  const cards = opts.videos.map((v) => {
    const id = v.id || "";
    const href = v.url && /^https?:/.test(v.url) ? v.url : "https://www.youtube.com/watch?v=" + id;
    const thumb = "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg";
    const dur = v.duration ? fmtDur(v.duration) : "";
    return (
      '<a class="card" href="proxy://' + href + '">' +
      '<div class="thumb"><img loading="lazy" data-src="proxy://' + thumb + '" alt=""><span class="dur">' + dur + '</span></div>' +
      '<div class="t">' + esc(v.title || "Untitled") + "</div>" +
      '<div class="c">' + esc(v.uploader || v.channel || "") + "</div>" +
      "</a>"
    );
  }).join("");

  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + esc(opts.title) + "</title><style>" +
    "*{margin:0;padding:0;box-sizing:border-box}" +
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f0f;color:#f1f1f1;padding:14px}" +
    "header{display:flex;align-items:center;gap:12px;max-width:1200px;margin:0 auto 16px;flex-wrap:wrap}" +
    "h1{font-size:20px;margin:0}" +
    "nav a{color:#3ea6ff;text-decoration:none;font-size:14px;margin-right:12px}" +
    "form{display:flex;flex:1;gap:8px;min-width:200px}" +
    "input[type=text]{flex:1;padding:8px 12px;background:#222;border:1px solid #333;border-radius:18px;color:#f1f1f1;font-size:14px}" +
    "input[type=text]:focus{outline:none;border-color:#3ea6ff}" +
    "button{padding:8px 16px;background:#3ea6ff;color:#000;border:none;border-radius:18px;font-weight:600;cursor:pointer}" +
    ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:18px;max-width:1200px;margin:0 auto}" +
    ".card{color:#f1f1f1;text-decoration:none;display:block}" +
    ".thumb{position:relative;aspect-ratio:16/9;overflow:hidden;border-radius:10px;background:#222}" +
    ".thumb img{width:100%;height:100%;object-fit:cover}" +
    ".dur{position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.8);padding:2px 5px;border-radius:4px;font-size:12px}" +
    ".t{margin-top:6px;font-size:14px;font-weight:500;line-height:1.3;max-height:2.6em;overflow:hidden}" +
    ".c{color:#aaa;font-size:12.5px;margin-top:2px}" +
    ".empty{color:#888;text-align:center;margin-top:60px;font-size:15px}" +
    "</style></head><body>" +
    "<header><h1>YouTube</h1><nav><a href=\"proxy://https://www.youtube.com/\">Home</a></nav>" +
    "<form action=\"proxy://https://www.youtube.com/results\" method=\"get\">" +
    "<input type=\"text\" name=\"search_query\" value=\"" + esc(opts.query || "") + "\" placeholder=\"Search\">" +
    "<button type=\"submit\">Search</button></form></header>" +
    '<div class="grid">' + (cards || '<div class="empty">No results</div>') + "</div>" +
    "</body></html>"
  );
}

function classifyDdg(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  const host = u.hostname.replace(/^www\./i, "");
  if (host !== "duckduckgo.com") return null;
  const q = u.searchParams.get("q");
  const p = u.pathname;
  if (q && (p === "/" || p === "" || /^\/search\/?$/.test(p))) return q;
  return null;
}

function classifyDdgImage(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  const host = u.hostname.replace(/^www\./i, "");
  if (host !== "duckduckgo.com") return null;
  const p = u.pathname;
  if (!/^\//.test(p)) return null;
  const imageMode = /(^|[?&])(iax|ia)=images($|[&])/.test(urlStr) || /^\/i[/?]/.test(p);
  if (!imageMode) return null;
  return u.searchParams.get("q") || "";
}

async function fetchBingImages(q) {
  const enc = encodeURIComponent(q);
  const r = await fetchUrl("https://www.bing.com/images/search?q=" + enc + "&first=1&count=40", { method: "GET" });
  const html = r.body.toString("utf8");
  const out = [];
  const seen = new Set();
  const mRe = /\bm="((?:[^"\\]|\\.)*)"/g;
  let cap;
  while ((cap = mRe.exec(html)) !== null) {
    try {
      const o = JSON.parse(cap[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
      if (!o.murl || !o.turl) continue;
      const key = o.murl;
      if (seen.has(key)) continue;
      seen.add(key);
      let purl = o.purl || o.murl;
      if (typeof purl === "string") purl = purl.replace(/\s+/g, "%20");
      out.push({ thumb: o.turl, image: o.murl, page: purl, title: o.t || "" });
      if (out.length >= 32) break;
    } catch {}
  }
  return out;
}

function imgPageHTML(opts) {
  const cards = opts.images.map((it) => {
    const host = (() => { try { return new URL(it.page).hostname.replace(/^www\./i, ""); } catch { return ""; } })();
    const title = esc(it.title || host || "Image");
    return (
      '<a class="card" href="proxy://' + it.page + '">' +
      '<div class="thumb"><img loading="lazy" data-src="proxy://' + it.thumb + '" alt="">' +
      '<span class="host">' + esc(host) + "</span></div>" +
      '<div class="t">' + title + "</div>" +
      "</a>"
    );
  }).join("");

  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + esc(opts.title) + "</title><style>" +
    "*{margin:0;padding:0;box-sizing:border-box}" +
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#151515;color:#f1f1f1;padding:14px}" +
    "header{display:flex;align-items:center;gap:12px;max-width:1200px;margin:0 auto 16px;flex-wrap:wrap}" +
    "h1{font-size:20px;margin:0}" +
    "nav a{color:#7dd3fc;text-decoration:none;font-size:14px;margin-right:12px}" +
    "form{display:flex;flex:1;gap:8px;min-width:200px}" +
    "input[type=text]{flex:1;padding:8px 12px;background:#202020;border:1px solid #333;border-radius:18px;color:#f1f1f1;font-size:14px}" +
    "input[type=text]:focus{outline:none;border-color:#7dd3fc}" +
    "button{padding:8px 16px;background:#7dd3fc;color:#000;border:none;border-radius:18px;font-weight:600;cursor:pointer}" +
    ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;max-width:1200px;margin:0 auto}" +
    ".card{color:#f1f1f1;text-decoration:none;display:block}" +
    ".thumb{position:relative;aspect-ratio:4/3;overflow:hidden;border-radius:8px;background:#222}" +
    ".thumb img{width:100%;height:100%;object-fit:cover}" +
    ".host{position:absolute;left:6px;bottom:6px;background:rgba(0,0,0,.75);padding:2px 6px;border-radius:4px;font-size:11px;max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".t{margin-top:6px;font-size:13.5px;font-weight:500;line-height:1.3;max-height:2.6em;overflow:hidden}" +
    ".empty{color:#888;text-align:center;margin-top:60px;font-size:15px}" +
    "</style></head><body>" +
    "<header><h1>Images</h1><nav><a href=\"proxy://https://duckduckgo.com/\">Search</a></nav>" +
    "<form action=\"proxy://https://duckduckgo.com/?iax=images&amp;ia=images\" method=\"get\">" +
    "<input type=\"text\" name=\"q\" value=\"" + esc(opts.query || "") + "\" placeholder=\"Search images\">" +
    "<button type=\"submit\">Search</button></form></header>" +
    '<div class="grid">' + (cards || '<div class="empty">No results</div>') + "</div>" +
    "</body></html>"
  );
}

async function handleImageSearch(ws, msg, url) {
  const q = classifyDdgImage(url);
  if (q === null) return false;
  const enc = encodeURIComponent(q);
  try {
    const images = q ? await fetchBingImages(q) : [];
    const out = rewriteHtml(imgPageHTML({ title: q ? q + " - Images" : "Images", query: q, images }), "https://www.bing.com/");
    ws.send(JSON.stringify({ type: "page", id: msg.id, url, title: out.title, html: out.html }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", id: msg.id, message: "Image search: " + err.message }));
  }
  return true;
}

async function handleDdgPage(ws, msg, url) {
  const q = classifyDdg(url);
  if (!q) return false;
  const enc = encodeURIComponent(q);
  const ddgTarget = "https://html.duckduckgo.com/html/?q=" + enc;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetchUrl(ddgTarget, { method: "GET" });
      const body = r.body.toString("utf8");
      const gated = r.status !== 200 || /(challenge-form|anomaly\.js|information_protection|unusual activity)/i.test(body);
      if (!gated) {
        const { html, title } = rewriteHtml(body, "https://html.duckduckgo.com/");
        ws.send(JSON.stringify({ type: "page", id: msg.id, url, title, html }));
        return true;
      }
      if (attempt < 2) { await new Promise((x) => setTimeout(x, 900)); console.log("[ddg] gated, retrying..."); }
    } catch (err) {
      if (attempt < 2) { await new Promise((x) => setTimeout(x, 900)); console.log("[ddg] err " + err.message + ", retrying..."); }
    }
  }
  console.log("[ddg] html endpoint gated, falling back to bing");
  try {
    const rb = await fetchUrl("https://www.bing.com/search?q=" + enc + "&setlang=en&count=20", { method: "GET" });
    const { html, title } = rewriteHtml(rb.body.toString("utf8"), "https://www.bing.com/");
    ws.send(JSON.stringify({ type: "page", id: msg.id, url, title, html }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", id: msg.id, message: "Search failed for query: " + q }));
  }
  return true;
}

async function handleYtPage(ws, msg, url) {
  const cls = classifyYt(url);
  if (!cls) return false;
  const urlStr = url;
  try {
    let videos, title;
    if (cls.kind === "home") {
      videos = await gridFromHome();
      title = "YouTube";
    } else if (cls.kind === "search") {
      videos = await gridFromSearch(cls.query);
      title = "YouTube search: " + cls.query;
    } else {
      videos = await gridFromList(cls.url);
      title = cls.title;
    }
    const html = rewriteHtml(ytPageHTML({ title, query: cls.query, videos }), "https://www.youtube.com/");
    ws.send(JSON.stringify({ type: "page", id: msg.id, url: urlStr, title, html: html.html }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", id: msg.id, message: "YouTube grid: " + err.message }));
  }
  return true;
}

async function handleFetch(ws, msg) {
  const url = String(msg.url || "").trim();

  if (await handleYtPage(ws, msg, url)) return;
  if (await handleImageSearch(ws, msg, url)) return;
  if (await handleDdgPage(ws, msg, url)) return;

  try {
    const r = await fetchUrl(url, { method: msg.method, body: msg.body, contentType: msg.contentType });
    if (r.contentType.includes("text/html")) {
      const { html, title } = rewriteHtml(r.body.toString("utf8"), baseOf(r.finalUrl));
      ws.send(JSON.stringify({ type: "page", id: msg.id, url: r.finalUrl, title, html }));
    } else {
      ws.send(JSON.stringify({ type: "resource", id: msg.id, url: r.finalUrl, mime: r.contentType, b64: r.body.toString("base64") }));
    }
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", id: msg.id, message: err.message }));
  }
}

async function handleResource(ws, msg) {
  const url = String(msg.url || "").trim();
  try {
    const r = await fetchUrl(url, { method: "GET" });
    ws.send(JSON.stringify({ type: "resource", id: msg.id, url: r.finalUrl, mime: r.contentType, b64: r.body.toString("base64") }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", id: msg.id, message: err.message }));
  }
}

function ytRun(args, maxBuffer) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { maxBuffer: maxBuffer || 64 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || "").slice(0, 500) || err.message));
      resolve(stdout);
    });
  });
}

async function handleYtInfo(ws, msg) {
  const url = String(msg.url || "").trim();
  try {
    const raw = await ytRun(["-J", "--no-playlist", "--no-warnings", url]);
    const j = JSON.parse(raw);
    const vid = j.id || "";
    const thumb = j.thumbnail || (j.thumbnails && j.thumbnails.length && j.thumbnails[j.thumbnails.length - 1].url) || "";

    const langTracks = new Map();
    const pick = (base, code, prio) => {
      const cur = langTracks.get(base);
      if (!cur || prio < cur.prio) langTracks.set(base, { code, prio });
    };
    const scan = (src, isManual) => {
      if (!src || typeof src !== "object") return;
      for (const code of Object.keys(src)) {
        const list = src[code] || [];
        if (!list.some((t) => /vtt|srv3|timedtext/i.test(String(t.ext || "") + String(t.url || "")))) continue;
        let base = code, prio = isManual ? 0 : 2;
        if (code.includes("-")) {
          const segs = code.split("-");
          const last = segs[segs.length - 1];
          if (last === "orig") { base = segs[0]; prio = 1; }                            // en-orig -> en
          else if (/^[A-Z]{2}\d*$/.test(last)) { base = segs[0]; prio = 3; }            // en-US -> en
          else if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$/.test(last)) { base = last; prio = 3; } // da-en -> en (English captions)
          else base = segs[0];
        }
        pick(base, code, prio);
      }
    };
    scan(j.subtitles, true);
    scan(j.automatic_captions, false);

    const common = ["en", "es", "fr", "de", "pt", "ru", "it", "ja", "ko", "zh-Hans", "zh-Hant", "ar", "hi", "nl", "pl", "sv", "tr", "da", "nb", "no", "fi", "cs", "el", "he", "id", "th", "uk", "hu"];
    const bases = [...langTracks.keys()];
    const ordered = [
      ...common.filter((c) => langTracks.has(c)),
      ...bases.filter((b) => !common.includes(b)).sort((a, b) => a.localeCompare(b)),
    ].slice(0, 60);
    const subs = ordered.map((base) => {
      let label = base;
      try { label = new Intl.DisplayNames(["en"], { type: "language" }).of(base) || base; } catch {}
      const track = langTracks.get(base);
      return { code: track.code, base, label };
    });

    ws.send(JSON.stringify({
      type: "ytinfo",
      id: msg.id,
      ok: true,
      url: j.webpage_url || url,
      videoId: vid,
      title: j.title || "",
      author: j.uploader || j.channel || "",
      duration: j.duration || 0,
      thumb,
      subs,
    }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", id: msg.id, message: "YouTube info: " + err.message }));
  }
}

async function handleYtDownload(ws, msg) {
  const url = String(msg.url || "").trim();
  const height = Math.min(Number(msg.height) || 360, 1080);
  const wantSub = String(msg.sub || "").trim();
  const fileId = Math.random().toString(36).slice(2);
  const dest = path.join(YT_CACHE, fileId + ".mp4");
  const subFile = dest.replace(/\.[A-Za-z0-9]+$/, "." + wantSub + ".vtt");

  try {
    ws.send(JSON.stringify({ type: "ytstart", id: msg.id }));

    const args = [
      "--ignore-errors",
      "--no-playlist", "--no-warnings", "--no-part",
      "-f", "bv*[vcodec^=avc][height<=" + height + "][fps<=30]+ba[acodec^=mp4a]/b[height<=" + height + "]",
      "-S", "res:" + height + ",vcodec:avc,ext:mp4",
      "--merge-output-format", "mp4",
      "--postprocessor-args", "ffmpeg:-movflags +faststart",
      "-o", dest,
      url,
    ];
    if (wantSub) {
      args.push("--write-subs", "--write-auto-subs", "--sub-langs", wantSub, "--sub-format", "vtt");
      if (HAS_CURL_CFFI) args.push("--impersonate", "chrome");
    }

    const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    ws._ytChild = child;

    let stderrBuf = "";
    child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

    await new Promise((resolve, reject) => {
      child.on("close", (code) => {
        if (code !== 0) {
          const brief = stderrBuf.split("\n").filter((l) => !/warn|deprecated/i.test(l)).join("\n").trim().slice(0, 500);
          return reject(new Error(brief || "yt-dlp exit " + code));
        }
        resolve();
      });
      child.on("error", reject);
    });

    const stat = fs.statSync(dest);
    ws.send(JSON.stringify({ type: "ytready", id: msg.id, size: stat.size }));

    const CHUNK = 100000;
    const buf = Buffer.alloc(stat.size);
    let offset = 0;

    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(dest, { highWaterMark: CHUNK });
      stream.on("data", (chunk) => {
        chunk.copy(buf, offset);
        offset += chunk.length;
      });
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    for (let i = 0; i < buf.length; i += CHUNK) {
      const slice = buf.slice(i, i + CHUNK);
      ws.send(JSON.stringify({ type: "ytchunk", id: msg.id, b64: slice.toString("base64") }));
    }
    ws.send(JSON.stringify({ type: "ytdone", id: msg.id, size: buf.length }));

    if (wantSub) {
      let vtt = "";
      if (fs.existsSync(subFile)) vtt = fs.readFileSync(subFile, "utf8");
      ws.send(JSON.stringify({ type: "ytsub", id: msg.id, vtt }));
    }

  } catch (err) {
    ws.send(JSON.stringify({ type: "error", id: msg.id, message: "YouTube download: " + err.message }));
  } finally {
    try { fs.unlinkSync(dest); } catch {}
    if (wantSub) { try { fs.unlinkSync(subFile); } catch {} }
  }
}

async function handleChatKey(ws, msg) {
  try {
    if (msg.get === true) {
      ws.send(JSON.stringify({ type: "chatreply", id: msg.id, ok: true, keySet: !!OPENAI_KEY, text: "", model: "" }));
      return;
    }
    const key = String(msg.key || "").trim();
    if (!key) {
      ws.send(JSON.stringify({ type: "error", id: msg.id, message: "No API key provided" }));
      return;
    }
    OPENAI_KEY = key;
    ws.send(JSON.stringify({ type: "chatreply", id: msg.id, ok: true, keySet: true, text: "", model: "" }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", id: msg.id, message: "chatkey: " + err.message }));
  }
}

async function cloudChat(model, msgs, maxTokens) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let res;
  try {
    res = await fetch("https://text.pollinations.ai/openai", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens }),
    });
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw;
    try { const j = JSON.parse(raw); detail = j.error && (j.error.message || j.error.code) || raw; } catch {}
    throw new Error("Pollinations " + res.status + ": " + (detail || raw).slice(0, 200));
  }
  let j;
  try { j = JSON.parse(raw); } catch { throw new Error("Pollinations: non-JSON reply"); }
  if (j.choices && j.choices[0] && j.choices[0].message) {
    return { text: j.choices[0].message.content || "", model: j.model || model };
  }
  throw new Error("Pollinations: unexpected reply shape");
}

async function handleChat(ws, msg) {
  try {
    const msgs = Array.isArray(msg.messages) ? msg.messages : [];
    if (!msgs.length) {
      ws.send(JSON.stringify({ type: "error", id: msg.id, message: "No messages" }));
      return;
    }
    const model = String(msg.model || "openai");
    const maxTokens = Number(msg.maxTokens) || 4096;

    let text, usedModel;
    if (OPENAI_KEY) {
      const body = { model, messages: msgs };
      if (Number(msg.maxTokens)) body.max_tokens = Number(msg.maxTokens);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      let res;
      try {
        res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + OPENAI_KEY,
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify(body),
        });
      } finally {
        clearTimeout(timer);
      }

      const raw = await res.text();
      if (!res.ok) {
        let detail = "";
        try { const j = JSON.parse(raw); detail = j.error && (j.error.message || j.error.code) || ""; } catch {}
        ws.send(JSON.stringify({ type: "error", id: msg.id, message: "OpenAI " + res.status + ": " + (detail || raw.slice(0, 200)) }));
        return;
      }
      const j = JSON.parse(raw);
      text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
      usedModel = j.model || model;
      ws.send(JSON.stringify({ type: "chatreply", id: msg.id, ok: true, text, model: usedModel, usage: j.usage || null }));
      return;
    }

    ({ text, model: usedModel } = await cloudChat(model, msgs, maxTokens));
    ws.send(JSON.stringify({ type: "chatreply", id: msg.id, ok: true, text, model: usedModel, free: true }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", id: msg.id, message: "Chat: " + err.message }));
  }
}

wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[proxy] client connected from ${ip}`);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "error", id: null, message: "invalid json" }));
      return;
    }

    if (msg.type === "fetch") {
      handleFetch(ws, msg);
    } else if (msg.type === "resource") {
      handleResource(ws, msg);
    } else if (msg.type === "yt") {
      handleYtInfo(ws, msg);
    } else if (msg.type === "ytdownload") {
      handleYtDownload(ws, msg);
    } else if (msg.type === "chatkey") {
      handleChatKey(ws, msg);
    } else if (msg.type === "chat") {
      handleChat(ws, msg);
    } else {
      ws.send(JSON.stringify({ type: "error", id: msg.id, message: "unknown type: " + msg.type }));
    }
  });

  ws.on("close", () => {
    if (ws._ytChild) { try { ws._ytChild.kill("SIGTERM"); } catch {} }
    console.log("[proxy] client disconnected");
  });
  ws.on("error", (err) => console.log("[proxy] error:", err.message));
});