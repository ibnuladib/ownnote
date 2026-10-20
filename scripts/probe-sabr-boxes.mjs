/**
 * Dump first SABR mux fMP4 boxes for 1080p / 720p to verify init segments.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

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
for (const db of walk(".wrangler/state")) {
  spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
}

const cookie = `ownnote_session=${TOKEN}`;

function boxName(bytes) {
  if (bytes.byteLength < 8) return "?";
  return String.fromCharCode(...bytes.subarray(4, 8));
}

async function probeHeight(height) {
  const startRes = await fetch(`${BASE}/api/media/youtube/${VIDEO_ID}/sabr/start`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: BASE,
    },
    body: JSON.stringify({ height }),
  });
  const started = await startRes.json();
  console.log("START", height, startRes.status, {
    label: started.label,
    videoMime: started.videoMime,
    audioMime: started.audioMime,
  });
  if (!startRes.ok) return;

  const muxRes = await fetch(`${BASE}${started.muxUrl}`, { headers: { Cookie: cookie } });
  console.log(
    "MUX",
    height,
    muxRes.status,
    muxRes.headers.get("x-sabr-video-mime"),
    muxRes.headers.get("x-sabr-audio-mime"),
  );
  if (!muxRes.ok || !muxRes.body) {
    console.log(await muxRes.text());
    return;
  }

  const reader = muxRes.body.getReader();
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

  let videoBytes = 0;
  let audioBytes = 0;
  const samples = [];
  for (let i = 0; i < 24; i++) {
    const header = await take(5);
    if (!header) break;
    const type = header[0];
    const len = new DataView(header.buffer, header.byteOffset, 5).getUint32(1);
    const payload = len ? await take(len) : new Uint8Array(0);
    if (!payload) break;
    if (type === 1) videoBytes += payload.byteLength;
    if (type === 2) audioBytes += payload.byteLength;
    if ((type === 1 || type === 2) && samples.length < 8) {
      samples.push({
        type: type === 1 ? "V" : "A",
        len: payload.byteLength,
        box: boxName(payload),
        hex: [...payload.subarray(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join(" "),
      });
    }
    if (type === 0) break;
    if (videoBytes > 80000 && audioBytes > 8000) break;
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  console.log({ height, videoBytes, audioBytes, samples });
  await fetch(`${BASE}/api/media/youtube/${VIDEO_ID}/sabr/${started.sessionId}`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: BASE },
  });
}

await probeHeight(1080);
await probeHeight(720);
