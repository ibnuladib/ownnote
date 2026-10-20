/**
 * Confirm SABR path refuses a mid-lecture seek into empty buffers and still plays from ~0.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

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
  video.muted = true;
  video.playsInline = true;
  document.body.appendChild(video);

  const ms = new MediaSource();
  const url = URL.createObjectURL(ms);
  video.src = url;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sourceopen timeout")), 15000);
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
    const copy = new Uint8Array(bytes);
    await waitUpdateEnd(sb);
    sb.appendBuffer(copy);
    await waitUpdateEnd(sb);
  };

  const ac = new AbortController();
  const demux = (async () => {
    const res = await fetch(started.muxUrl, { credentials: "include", signal: ac.signal });
    const reader = res.body.getReader();
    let pending = new Uint8Array(0);
    const take = async (n) => {
      while (pending.byteLength < n) {
        const { done, value } = await reader.read();
        if (done) return null;
        const next = new Uint8Array(pending.byteLength + value.byteLength);
        next.set(pending);
        next.set(value, pending.byteLength);
        pending = next;
      }
      const out = pending.subarray(0, n);
      pending = pending.subarray(n);
      return out;
    };
    while (true) {
      const header = await take(5);
      if (!header) break;
      const type = header[0];
      const len = new DataView(header.buffer, header.byteOffset, 5).getUint32(1);
      const payload = len ? await take(len) : new Uint8Array(0);
      if (!payload) break;
      if (type === 1) await appendBytes(vSb, payload);
      else if (type === 2) await appendBytes(aSb, payload);
      else if (type === 0) break;
      if (video.buffered.length && video.buffered.end(0) > 0.5) break;
    }
  })();

  // Wait until buffered like whenReady
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (video.buffered.length && video.buffered.start(0) <= 0.5 && video.buffered.end(0) >= 0.35) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const bufferedEnd = video.buffered.length ? video.buffered.end(0) : 0;

  // Mirror player: refuse resume at 3333 when only a few seconds are buffered.
  const resumeFrom = 3333;
  let playFrom = 0;
  let mode = "start-over";
  if (resumeFrom > 1 && resumeFrom > bufferedEnd - 0.5) {
    playFrom = 0;
    mode = "start-over";
  } else {
    playFrom = resumeFrom;
    mode = "seek";
  }
  video.currentTime = playFrom;
  await video.play();
  await new Promise((r) => setTimeout(r, 1500));

  ac.abort();
  await fetch(`/api/media/youtube/${videoId}/sabr/${started.sessionId}`, {
    method: "DELETE",
    credentials: "include",
  }).catch(() => {});

  return {
    mode,
    bufferedEnd,
    after: {
      paused: video.paused,
      currentTime: video.currentTime,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    },
  };
}, { videoId: VIDEO_ID });

console.log(JSON.stringify(result, null, 2));
await browser.close();
const ok =
  result.mode === "start-over" &&
  result.after.videoWidth >= 1280 &&
  result.after.currentTime > 0.2 &&
  result.after.currentTime < 60 &&
  !result.after.paused;
process.exit(ok ? 0 : 2);
