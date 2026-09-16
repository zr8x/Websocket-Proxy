# WS Proxy Browser — Project Memory

> **Action log:** every important change gets a dated entry in [Action log](#action-log) below. Keep it updated.

## Purpose
A WebSocket-based proxy browser pair that lets a restricted Chromebook (enterprise-managed, admin-locked, dev-mode/crosh disabled) browse the web, watch YouTube, search the web, view images, and chat with an AI — entirely over a single WebSocket connection to a Node relay/proxy server. The Chromebook only loads one offline HTML file.

## Architecture
- **Client** (`browser.html`): single offline file. Toolbar + URL bar, settings panel for WebSocket URL, sandboxed `srcdoc` iframe, YouTube player overlay, ChatGPT-style chat overlay. Routes special URLs into custom apps (YouTube watch → player, `chatgpt.com` → chat app, DDG image-mode → server-side image grid).
- **Server** (`server.js`): Node + `ws`. Fetches pages, rewrites HTML (see below), serves resources, generates YouTube/image grids, runs yt-dlp, calls chat backends. Chat/state is per-process (in memory).
- **Inject** (`inject.js`): attached to every proxied page. Resolves `proxy://` resources to blob URLs, intercepts clicks/forms, reports titles, observes DOM mutations.

## How proxying works
- Client → server message types: `fetch`, `resource`, `yt`, `ytdownload`, `chatkey`, `chat`. All carry an `id`; responses echo it.
- Server → client: `page`, `resource`, `ytinfo`/`ytstart`/`ytready`/`ytchunk`/`ytdone`/`ytsub`, `chatreply`, `error`.
- `rewriteHtml()` / `rewriteUrl()`: rewrites `href/src/action/poster/data-src/srcset` to `proxy://<absolute-url>`; strips `<base>`, CSP meta, and refresh meta; appends `inject.js` before `</body>` (+ implicit `<base>`/origin handling noted below).
- Binary payloads travel as base64. `ytdownload` messages have no `id`; the client routes them by `type` only.
- **Common gotcha:** `rewriteHtml()` returns `{html, title}` — do NOT send the whole object as `m.html` (caused blank image pages once). Always send `out.html` / `out.title`.

## Startup / ops
```bash
cd ~/Documents/chromeTest/wsproxy
nohup node server.js >/tmp/opencode/wsproxy.log 2>&1 &   # port 8080 (PORT env overrides)
```
- Server reads `inject.js` once at startup — **must restart** after editing `inject.js`.
- Port 8080 is shared with the older `relay/` project — kill the other listener before starting (use `ss -tlnp | grep 8080`).
- To reach from the Chromebook over the internet, expose with an **HTTP** ngrok tunnel (`ngrok http 8080`), client WS URL = `wss://<name>.ngrok-free.app`. Old SSH TCP tunnel (`ngrok tcp 127.0.0.1:22`) is unrelated to this project.

## Key files
- `server.js` — everything server-side.
- `inject.js` — in-frame routing script.
- `browser.html` — single-file client (has its own embedded JS; `node --check` the extracted `<script>` block to validate).
- `.venv/bin/yt-dlp` — the only working YouTube extractor (v2026.08.19).
- `/tmp/opencode/wsproxy.log` — server log (search for `[ddg]`, `[yt]`, `[proxy]` lines for diagnostics).
- `/home/zr8x/Documents/chromeTest/relay/` — older WS⇄TCP relay (echo + TCP target); different project, same port.
- `/home/zr8x/Documents/chromeTest/iwa/` — abandoned IWA/extension project (admin allowlist blocked it).

## Site-specific behaviors (server-side handlers in `handleFetch`, checked in order)
1. **YouTube** (`handleYtPage`): watch/shorts URLs → client opens the video player (blob video, quality select 360/480/720). Home/search/list/channel URLs → server-generated grid pages (`ytPageHTML`), thumbs via yt-dlp `hqdefault.jpg` as `data-src="proxy://…"`.
2. **DDG image mode** (`handleImageSearch`, `classifyDdgImage`): URLs with `iax=images`/`ia=images` → scrape `bing.com/images/search` (parse `m="…"` JSON attrs for `murl/turl/purl`), render `imgPageHTML` grid. Clicking a card navigates to the image's source page.
3. **DDG web search** (`handleDdgPage`): `duckduckgo.com/?q=…` → try `html.duckduckgo.com/html/?q=` up to 3 times (~0.9s apart); if 202-gated/challenge, fall back to Bing web search. Bing from this datacenter IP is intermittently junk (e.g. "capital of germany" → Capital One/Boston), so DDG-html is preferred.
4. **Everything else**: generic fetch + rewrite.

## YouTube specifics
- YouTube is DASH-only now (no combined progressive MP4), so the server must download video+audio and merge with ffmpeg.
- Forced format (fixes stutter — VP9/AV1 decode is too heavy for the Chromebook):
  `-f "bv*[vcodec^=avc][height<=H][fps<=30]+ba[acodec^=mp4a]/b[height<=H]" -S "res:H,vcodec:avc,ext:mp4,m4a" --merge-output-format mp4 --postprocessor-args "ffmpeg:-movflags +faststart"`
  → typically resolves to 133+140 (H.264 360p + AAC).
- `ytdl-core` (both @distube and original) and `youtubei.js` FAIL ("Failed to find any playable formats" / parser errors). Do NOT retry those; yt-dlp is the only working path.
- Streams to client in ~100KB base64 chunks into a blob URL.
- **Subtitles/CC** (added 2026-09-16): `handleYtInfo` reports `subs` (caption-text languages, best track per language: manual > `-orig` > plain > translated; common langs prioritized; cap 60). Pass `msg.sub` (exact track code) in `ytdownload` → yt-dlp gets `--write-subs --write-auto-subs --sub-langs <code> --sub-format vtt` (+`--impersonate chrome` if curl_cffi present) + `--ignore-errors` (sub failure never aborts video). VTT read from `dest-with-code.vtt`, sent as `ytsub`, unlinked in `finally`. Client: subtitle `<select>` (auto-default base `en`), `attachSubs(vtt)` **does NOT use Chrome's native `<track>` or `addTextTrack`** (Chromium on managed Chromebooks silently ignores both). Instead, `parseVtt()` extracts cues; a custom overlay `<div>` is appended to `#ytPlayer` (positioned absolute at `bottom:48px`, `z-index:10`, `pointer-events:none`) and `updateSubtitles()` updates it on every `timeupdate` event.
- Known nuance: killing a download mid-flight (esp. a hung WS client) can leave yt-dlp component files (`*.f133.mp4`/`.f140.m4a`) in the YT_CACHE tmpdir; the server's `finally` cleanup only removes the final dest. Harmless tmp junk, but worth knowing.

## Chat (free by default, no API key)
- `chatgpt.com` (any path) is intercepted client-side (`isChatGpt`) and opens the built-in chat app — the real chatgpt.com site CANNOT work through this static proxy (SPA needs real origin/cookies) and is additionally blocked on the user's network, so it rides the API instead.
- **Free backend (default): Pollinations** (`POST https://text.pollinations.ai/openai`, OpenAI-shaped JSON, `choices[0].message.content`). No key. Models: `openai`, `openai-large`, `llama`, `mistral` (client dropdown).
- **Optional OpenAI backend**: if the user sets an `sk-…` key via the chat Key dialog (`chatkey` message), `handleChat` uses OpenAI `v1/chat/completions` instead. Key stored server-side in-memory only; wiped on process restart (client re-prompts, but no longer requires it).
- `chatkey` supports `{get:true}` to query whether a key is set without sending one.
- Client renders replies with a dependency-free, XSS-safe mini-markdown renderer (`mdRender`/`mdInline` in `browser.html`) — headings, bold/italic, inline & fenced code, lists, blockquotes, links, hr.

## Search engine scrape status (server IP = datacenter)
- `html.duckduckgo.com` and `lite.duckduckgo.com`: flaky — often return 202 Anomaly challenge (IP-gated, no reusable cookie). GET and POST both gated.
- `bing.com/search`: 200, scrapable, but result relevance is unpredictable from this IP.
- `bing.com/images/search`: reliable, `iuSc`/`m="…"` attributes give `murl`/`purl`/`turl`.
- `brave.com`, `ecosia`, `google.com`, `startpage.com`, `mojeek`, `stract`, `onesearch`: blocked / bot-walled / no headings. Don't re-try.

## Known issues / gotchas
- ChromeOS `browser.html` is loaded as a local file; when testing server changes, restart `server.js`; when testing client changes, just reload `browser.html` (no edit to `inject.js` → no restart needed; if injected that goes out at server start).
- Search result quality can be wrong when Bing is the fallback; DDG-html is the good-but-flaky source. If a user reports junk results, it's the Bing fallback — re-verify DDG-html availability.
- YouTube: no login/age-restricted videos, quality capped at 720p.
- OpenAI key is in-memory only — no persistence. Consider env var `OPENAI_API_KEY` for a persistent key.
- Port 8080 conflicts with the `relay/` project listener.

## Testing recipes
- `ss -tlnp | grep 8080` — confirm server up; kill stale PID if `EADDRINUSE`.
- Server-side e2e: open a `ws://localhost:8080` WS from a small Node script using `require('ws')` from `wsproxy/node_modules`, send `{type:'fetch',id:1,url:'https://duckduckgo.com/?q=...'}`, inspect `page.html`.
- Validate client JS: extract the `<script>` block and `node --check` it.
- Validate `server.js`: `node --check server.js`.

## Action log
<details><summary>2026-09-16 — YouTube subtitles/CC</summary>

**What:** Added subtitle/CC support end-to-end.
- `server.js` `handleYtInfo`: now returns `subs` — VTT-capable language codes from `j.subtitles` + `j.automatic_captions` (cap 25), labels via `Intl.DisplayNames(["en"])`.
- `server.js` `handleYtDownload`: accepts `msg.sub`; adds `--write-subs --write-auto-subs --sub-langs <code> --sub-format vtt --no-warnings`; after `ytdone` sends `{type:"ytsub", vtt}` read from `dest.<code>.vtt` (empty string if absent); unlinks the vtt in `finally`.
- `browser.html`: subtitle `<select>` populated from `ytinfo.subs` (auto-default base `en`), passed to `ytdownload`; `ytsub` routed to `handleYtEvent`; `attachSubs(vtt)` renders CC via a custom overlay `<div>` (child of `#ytPlayer`, absolute-positioned bottom-center, updated on `video.timeupdate`) — Chrome's native `<track>` / `addTextTrack` are both broken on managed Chromebooks. Cleaned up on close/new video.
- Verified e2e over the WS: `jNQXAC9IVRw` ("Me at the zoo") → `INFO subs=[{de:German},{en:English}]`; download with `sub=de` returned 744,412 B / 8 chunks + valid WebVTT (`WEBVTT / Kind: captions / Language: en`, 440 B). Sub/dest files removed in `finally`.
- Restarted server with new code; `node --check` passed on server + client JS.

**Gotcha:** an aborted mid-download test run leaves yt-dlp component files (`*.f133.mp4`, `*.f140.m4a`) in the YT_CACHE tmpdir — server cleanup only removes final dest + sub. tmp junk only.
</details>

<details><summary>2026-09-16 — CC fixes: missing English + 429 hard-fail</summary>

**User reports:** (1) subtitles dropdown had no English option; (2) picking Danish failed the whole download with `HTTP Error 429: Too Many Requests` plus an `m4a` deprecation warning in the error text.

**Root causes:**
- Missing English: videos expose ~150+ auto-caption languages; the old code capped the alphabetical list at 25, which truncated before `en` but after `da`. Also language *sources* (`da-en`, `en-orig`, `en-US`) were shown raw instead of normalized to caption text language.
- 429: YouTube rate-limits **auto-translated** captions per-IP (datacenter IPs are worst); by default yt-dlp aborts the entire download on subtitle failure. Original-language (`-orig`) and manual subs download fine.

**Fixes (`server.js` + `browser.html`):**
- `handleYtInfo` now maps every manual/auto caption key to its *caption text language* (`en-orig`/`en-US`/`da-en` → `en`), picks the safest exact track per language (manual > `-orig` > plain > translated), prioritizes ~28 common languages first so English/primary languages always show, cap raised to 60.
- `handleYtDownload`: `--ignore-errors` (sub failure can never kill the video), `--sub-format vtt`, `--impersonate chrome` when curl_cffi is installed, dropped deprecated `m4a` sort term from `-S`, error message now filters WARNING/Deprecated lines.
- `browser.html`: subtitle options carry `value` = exact track code + `data-lang` = base language; auto-default to base `en`; `<track>.srclang` uses `data-lang`.
- Installed `curl_cffi 0.16.3` into `.venv`; `HAS_CURL_CFFI` probed at server start.

**Verified e2e over WS:**
- Me at the zoo → subs `[English(en), German(de)]`; `sub=de` → video 744,412 B + 338 B VTT ✓
- Gangnam (Korean, 157 auto langs) → English present in list; `sub=en` (translated) → video completes (15.7 MB) with subs gracefully empty ✓ (429 confirmed upstream, all of ios/tv/android_vr/web clients also fail — do NOT chase this)
- `sub=ko-orig` (original-language, same shape as Danish `da-orig`) → video + 11,916 B VTT ✓
</details>

<details><summary>2026-09-16 — CC downloads but doesn't display</summary>

**User report:** subtitles download fine but never show in the player.

**Root cause:** the client rendered CC via a `<track kind="subtitles">` element with a blob URL, injected *after* the video had already started playing. Chromium has a long-standing bug where `<track>` elements added after `src`/playback don't get loaded/displayed.

**Fix (`browser.html` only, no server change):** `attachSubs(vtt)` no longer uses `<track>`. It parses the VTT with `parseVtt()` (handles `HH:MM:SS.mmm` and `MM:SS.mmm` cues, strips `<…>` markup and HTML entities) and injects cues directly via `video.addTextTrack("subtitles", …)` + `VTTCue`, forcing `mode="showing"` before and after adding cues (with a `loadedmetadata` retry). Old track disabled on replace/close.

**Verified** in a Node DOM-stub harness: 3 cues parsed from a realistic VTT (correct start/end/times, markup stripped, `&amp;` decoded, `MM:SS.mmm` format handled), track `kind=subtitles` `lang=ko` `mode=showing`; clear disables the old track. Client JS passes `node --check`.
</details>

<details><summary>2026-09-16 — CC still invisible after addTextTrack fix</summary>

**User report:** subtitles download but still don't show in the player (second attempt after switching from `<track>` elements to `addTextTrack`/`VTTCue`).

**Root cause:** Chrome's `addTextTrack` API also silently fails on managed Chromebooks — TextTracks are added internally but the browser's native CC renderer never paints them. Both approaches (DOM `<track>` and programmatic `addTextTrack`) are broken in this restricted environment.

**Fix (`browser.html` only):** Ditched Chrome's native CC entirely. `attachSubs(vtt)` now calls `parseVtt()` (unchanged) to get cue arrays, creates a `<div>` overlay appended to `#ytPlayer` (absolute-positioned at `bottom:48px`, `z-index:10`, `pointer-events:none`, styled with semi-transparent black background / white 18px text), and `updateSubtitles()` updates its `textContent` on every `video.timeupdate` event (linear search through sorted cues). Removed all `addTextTrack`/`VTTCue`/blob-URL code; the overlay is removed on close and re-created per language. Updated `project.md` bullets accordingly.

**Verified** in Node DOM-stub harness: 3 cues parsed, overlay gets correct text at each time offset, old overlay removed on clear.
</details>