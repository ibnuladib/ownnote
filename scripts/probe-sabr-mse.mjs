/**
 * Headless Chromium: fetch SABR mux and try MediaSource append for the fixture.
 * Uses the same D1 session cookie trick as probe-sabr-api.mjs.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const VIDEO_ID = process.argv[2] || "9vM4p9NN0Ts";
const HEIGHT = Number(process.argv[3] || 720);
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
for (const db of walk(".wrangler/state")) {
  spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addCookies([
  { name: "ownnote_session", value: TOKEN, url: BASE },
]);
const page = await context.newPage();
page.on("console", (msg) => console.log("BROWSER", msg.type(), msg.text()));
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });

const result = await page.evaluate(
  async ({ base, videoId, height }) => {
    const log = [];
    const startRes = await fetch(`${base}/api/media/youtube/${videoId}/sabr/start`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ height }),
    });
    const started = await startRes.json();
    log.push({ step: "start", status: startRes.status, started });
    if (!startRes.ok) return { ok: false, log };

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    document.body.appendChild(video);

    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    video.src = url;

    const sourceOpen = new Promise((resolve, reject) => {
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
    await sourceOpen;

    const vType = started.videoMime.includes("codecs=")
      ? started.videoMime
      : 'video/mp4; codecs="avc1.4d401f"';
    const aType = started.audioMime.includes("codecs=")
      ? started.audioMime
      : 'audio/mp4; codecs="mp4a.40.2"';
    log.push({
      step: "types",
      vType,
      aType,
      vOk: MediaSource.isTypeSupported(vType),
      aOk: MediaSource.isTypeSupported(aType),
    });
    if (!MediaSource.isTypeSupported(vType) || !MediaSource.isTypeSupported(aType)) {
      return { ok: false, log, error: "type not supported" };
    }

    const vSb = ms.addSourceBuffer(vType);
    const aSb = ms.addSourceBuffer(aType);
    vSb.mode = "segments";
    aSb.mode = "segments";

    const errors = [];
    vSb.addEventListener("error", () => errors.push("video-sb-error"));
    aSb.addEventListener("error", () => errors.push("audio-sb-error"));
    video.addEventListener("error", () =>
      errors.push(`video-error:${video.error?.code}:${video.error?.message}`),
    );

    const waitUpdateEnd = (sb) =>
      sb.updating
        ? new Promise((r) => sb.addEventListener("updateend", () => r(), { once: true }))
        : Promise.resolve();

    const appendBytes = async (sb, bytes) => {
      const CHUNK = 256 * 1024;
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
        const slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.byteLength));
        const copy = new Uint8Array(slice.byteLength);
        copy.set(slice);
        await waitUpdateEnd(sb);
        sb.appendBuffer(copy);
        await waitUpdateEnd(sb);
      }
    };

    const muxRes = await fetch(`${base}${started.muxUrl}`, { credentials: "include" });
    log.push({
      step: "mux",
      status: muxRes.status,
      vMime: muxRes.headers.get("x-sabr-video-mime"),
      aMime: muxRes.headers.get("x-sabr-audio-mime"),
    });
    if (!muxRes.ok || !muxRes.body) {
      return { ok: false, log, error: await muxRes.text() };
    }

    const reader = muxRes.body.getReader();
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

    let frames = 0;
    let videoBytes = 0;
    let audioBytes = 0;
    let appendErrors = 0;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const header = await readExact(5);
      if (!header) break;
      const type = header[0];
      const len = new DataView(header.buffer, header.byteOffset, 5).getUint32(1);
      const payload = len > 0 ? await readExact(len) : new Uint8Array(0);
      if (!payload) break;
      frames++;
      try {
        if (type === 1) {
          videoBytes += payload.byteLength;
          await appendBytes(vSb, payload);
        } else if (type === 2) {
          audioBytes += payload.byteLength;
          await appendBytes(aSb, payload);
        } else if (type === 0) {
          break;
        }
      } catch (e) {
        appendErrors++;
        errors.push(`append:${e instanceof Error ? e.message : String(e)}`);
        break;
      }
      // Enough to attempt play
      if (videoBytes > 200_000 && audioBytes > 20_000) break;
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }

    const vBuffered = vSb.buffered.length
      ? { start: vSb.buffered.start(0), end: vSb.buffered.end(0) }
      : null;
    const aBuffered = aSb.buffered.length
      ? { start: aSb.buffered.start(0), end: aSb.buffered.end(0) }
      : null;
    log.push({
      step: "buffered",
      frames,
      videoBytes,
      audioBytes,
      appendErrors,
      vBuffered,
      aBuffered,
      errors,
      readyState: video.readyState,
      networkState: video.networkState,
    });

    let playResult = null;
    try {
      await video.play();
      await new Promise((r) => setTimeout(r, 1500));
      playResult = {
        paused: video.paused,
        currentTime: video.currentTime,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
      };
    } catch (e) {
      playResult = { playError: e instanceof Error ? e.message : String(e) };
    }
    log.push({ step: "play", playResult });

    await fetch(`${base}/api/media/youtube/${videoId}/sabr/${started.sessionId}`, {
      method: "DELETE",
      credentials: "include",
    });

    const ok =
      !!vBuffered &&
      vBuffered.end > 0 &&
      !!aBuffered &&
      aBuffered.end > 0 &&
      (playResult?.currentTime > 0 || playResult?.videoWidth > 0);
    return { ok, log, errors };
  },
  { base: BASE, videoId: VIDEO_ID, height: HEIGHT },
);

console.log(JSON.stringify(result, null, 2));
await browser.close();
process.exit(result.ok ? 0 : 1);
