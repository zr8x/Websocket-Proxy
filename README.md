# WS Browser

A lightweight web browser that lives in one offline HTML file. It connects to a relay proxy over a WebSocket and does all of its browsing, YouTube, and AI chat through that connection — so it works from restricted or managed devices (Chromebooks) where normal browsing, extensions, or apps are locked down.

You only need **one file** to use it: `browser.html`. The server runs elsewhere; you don't need to manage or touch it.

---

## Start here

1. Open `launcher.html` in Chrome (double-click the file, or open it in a browser tab).
2. Click **Relay** (top-right).
3. In the WebSocket URL box, paste the relay address you were given (looks like `ws://…` or `wss://…`), then click **Connect**.
4. You're in. The browser opens **DuckDuckGo** automatically — just type a URL or a search.

The URL bar, back/forward/reload buttons, and the `Go` button all work like a normal browser.

> Tip: the page loads fine with no internet to the app itself, since browsing happens over the WebSocket — it's a single offline file you can keep on your device.

---

## Features

### Web browsing
- Type any web address into the URL bar and press **Enter** (or hit **Go**). `https://` is added automatically if you leave it out.
- **Back / Forward / Reload** buttons behave like a regular browser.
- Links, forms, and page resources (images, CSS, scripts) are all fetched through the proxy, so pages work even where direct access from your device is blocked.

### Search
- The home page is **DuckDuckGo**. Search from the box, or use the URL bar.
- Web results are re-served through the proxy — no JavaScript needed on your device.

### Image search
- On a DuckDuckGo results page, click **Images** to get a photo grid for your query.
- Thumbnails load through the proxy. Tap any image to open its source page.

### YouTube
- **Watch videos** — open any YouTube video link (normal watch URLs, short links, or Shorts). A built-in player opens with a quality picker (360 / 480 / 720), a progress bar, and a **Play** button. The video is streamed through the proxy and plays straight in the browser.
- **Search & browse** — YouTube home, search results, channel, and playlist pages are shown as clean, fast **grid pages** (thumbnails + titles). Click a video to play it.
- Quality is optimized for restricted devices (low-resolution H.264), so playback is smooth instead of stuttery.

### ChatGPT (AI chat)
- Type `chatgpt.com` in the URL bar (or follow a link to it) to open the built-in chat app.
- It works **for free with no API key** — just start typing.
- Pick a model from the dropdown: `openai` (default), `openai-large`, `llama`, or `mistral`.
- Replies are formatted: **bold**, *italics*, `code`, code blocks, lists, headings — proper **Markdown rendering**.
- Buttons: **New chat** (start a fresh conversation), **Back** (leave chat and return to browsing), **Key** (optional — see below).
- Optional: want better models from your own account? Click **Key**, paste an OpenAI API key (`sk-...`). Doing so switches chat to OpenAI. Without a key, it stays free.

---

## Settings & connection

- **Relay** button toggles the connection panel.
- The connection status is shown next to the URL box field: `Connecting…` → `Connected`.
- If you lose connection, click **Disconnect**, then **Connect** again.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Not connected" / connect fails | Check the URL in the Relay panel Try reconnecting. |
| Blank recovers | Press Reload in the toolbar, or re-enter the URL. |
| Chat says "Thinking…" forever / errors | The free chat service can be slow or temporarily overloaded. Wait, retry, or switch model in the dropdown. |
| Mistake — searched and got odd results | Search engines sometimes behave oddly through relays. Just search again. |
| YouTube won't play a video | Some videos are restricted/age-gated. Try a different video; lower the quality setting. |

---

## Notes

- Chat history and browsing history live only while the app is open — nothing is saved on the server (the optional API key, if you set one, is held on the server in memory only and never sent back to your device).
- For anything unexpected, ask zr8x — you don't need to touch the server yourself.
