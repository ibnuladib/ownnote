/**
 * Reproduce attachSabrMse timing: resolve whenReady at 500ms, unmuted play(),
 * then check whether playback actually advances (mirrors YouTubePlayer path).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const VIDEO_ID = process.argv[2] || "9vM4p9NN0Ts";
const BASE = process.env.OWNNOTE_BASE || "http://127.0.0.1:8787";
const TOKEN = "sabr-probe-token-ownnote-2026";
const sessionIdHash = createHash("sha256").update(TOKEN).digest("hex");
const exp = Date.now() + 86400000;
const created = new Date().toISOString();

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, name.name);
    if (name.isDirectory()) walk(p, out);
    else if (name.name.endsWith(".sqlite")) out.push(p);
  }
  return out;
}

const sql = `INSERT OR REPLACE INTO sessions (id, created_at, expires_at) VALUES ('${sessionIdHash}', '${created}', ${exp});`;
for (const db of walk(".wrangler/state")) spawnSync("sqlite3", [db, sql]);

// Inline a minimal copy of attachSabrMse timing semantics.
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addCookies([{ name: "ownnote_session", value: TOKEN, url: BASE }]);
const page = await context.newPage();
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });

const result = await page.evaluate(async ({ videoId }) => {
  const startRes = await fetch(`/api/media/youtube/${videoId}/sabr/start`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ height: 1080 }),
  });
  const started = await startRes.json();

  const video = document.createElement("video");
  video.playsInline = true;
  // NOT muted — mirrors YouTubePlayer
  video.muted = false;
  document.body.appendChild(video);

  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  const ac = new AbortController();
  video.src = objectUrl;

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sourceopen timeout")), 10000);
    ms.addEventListener(
      "sourceopen",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

  const vSb = ms.addSourceBuffer(started.videoMime);
  const aSb = ms.addSourceBuffer(started.audioMime);
  vSb.mode = "segments";
  aSb.mode = "segments";

  const waitUpdateEnd = (sb) =>
    sb.updating
      ? new Promise((r) => sb.addEventListener("updateend", () => r(), { once: true }))
      : Promise.resolve();

  const appendBytes = async (sb, bytes) => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await waitUpdateEnd(sb);
    sb.appendBuffer(copy);
    await waitUpdateEnd(sb);
  };

  const demuxPromise = (async () => {
    const res = await fetch(started.muxUrl, { credentials: "include", signal: ac.signal });
    if (!res.ok || !res.body) throw new Error("mux failed " + res.status);
    const reader = res.body.getReader();
    let pending = new Uint8Array(0);
    const fill = async (n) => {
      while (pending.byteLength < n) {
        const { done, value } = await reader.read();
        if (done) return false;
        const next = new Uint8Array(pending.byteLength + value.byteLength);
        next.set(pending);
        next.set(value, pending.byteLength);
        pending = next;
      }
      return true;
    };
    const readExact = async (n) => {
      if (!(await fill(n))) return null;
      const out = pending.subarray(0, n);
      pending = pending.subarray(n);
      return out;
    };
    while (!ac.signal.aborted) {
      const header = await readExact(5);
      if (!header) break;
      const type = header[0];
      const len = new DataView(header.buffer, header.byteOffset, 5).getUint32(1);
      const payload = len > 0 ? await readExact(len) : new Uint8Array(0);
      if (!payload) break;
      if (type === 1) await appendBytes(vSb, payload);
      else if (type === 2) await appendBytes(aSb, payload);
      else if (type === 0) break;
    }
  })();
  demuxPromise.catch(() => {});

  // Mirror whenReady: wait only 500ms then "ready"
  await new Promise((r) => setTimeout(r, 500));
  const atReady = {
    bufferedLen: video.buffered.length,
    readyState: video.readyState,
    paused: video.paused,
  };

  let playError = null;
  try {
    await video.play();
  } catch (e) {
    playError = e instanceof Error ? e.message : String(e);
  }

  // Wait for more data like a user staring at "Playing…"
  await new Promise((r) => setTimeout(r, 8000));

  const after = {
    playError,
    paused: video.paused,
    currentTime: video.currentTime,
    readyState: video.readyState,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    buffered:
      video.buffered.length > 0
        ? { start: video.buffered.start(0), end: video.buffered.end(0) }
        : null,
  };

  ac.abort();
  await fetch(`/api/media/youtube/${videoId}/sabr/${started.sessionId}`, {
    method: "DELETE",
    credentials: "include",
  });

  return { started: { label: started.label, videoMime: started.videoMime }, atReady, after };
}, { videoId: VIDEO_ID });

console.log(JSON.stringify(result, null, 2));
await browser.close();
process.exit(result.after.videoWidth > 0 && result.after.currentTime > 0 && !result.after.paused ? 0 : 2);
