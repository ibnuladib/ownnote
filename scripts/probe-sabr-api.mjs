/**
 * Authenticate via a temporary D1 session row, then hit meta + sabr/start + mux for the fixture.
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

const sqlites = walk(".wrangler/state");
if (!sqlites.length) {
  console.error("No local D1 sqlite found under .wrangler/state");
  process.exit(1);
}

const sql = `INSERT OR REPLACE INTO sessions (id, created_at, expires_at) VALUES ('${sessionIdHash}', '${created}', ${exp});`;
let inserted = false;
for (const db of sqlites) {
  const r = spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
  if (r.status === 0) {
    console.error("session inserted into", db);
    inserted = true;
  }
}
if (!inserted) {
  console.error("Could not insert session");
  process.exit(1);
}

const cookie = `ownnote_session=${TOKEN}`;
const metaRes = await fetch(`${BASE}/api/media/youtube/${VIDEO_ID}`, {
  headers: { Cookie: cookie, Accept: "application/json" },
});
const meta = await metaRes.json();
console.log("META", metaRes.status);
console.log(
  JSON.stringify(
    {
      kind: meta.kind,
      height: meta.height,
      itag: meta.itag,
      label: meta.label,
      sabr: meta.sabr,
      qualities: meta.qualities,
    },
    null,
    2,
  ),
);
if (metaRes.status !== 200) process.exit(2);
if (meta.kind !== "progressive") {
  console.error("FAIL: meta preferred is not progressive (fast-start default)");
  process.exit(3);
}
const hasSabr720 = (meta.qualities ?? []).some(
  (q) => q.kind === "sabr" && (q.height ?? 0) >= 720,
);
if (!hasSabr720) {
  console.error("FAIL: SABR ≥720p missing from quality ladder");
  process.exit(4);
}

const startRes = await fetch(`${BASE}/api/media/youtube/${VIDEO_ID}/sabr/start`, {
  method: "POST",
  headers: {
    Cookie: cookie,
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: BASE,
  },
  body: JSON.stringify({ height: 720 }),
});
const started = await startRes.json();
console.log("START", startRes.status);
console.log(JSON.stringify(started, null, 2));
if (startRes.status !== 200 || !started.muxUrl) process.exit(5);

const muxRes = await fetch(`${BASE}${started.muxUrl}`, { headers: { Cookie: cookie } });
console.log(
  "MUX",
  muxRes.status,
  "videoMime",
  muxRes.headers.get("x-sabr-video-mime"),
  "audioMime",
  muxRes.headers.get("x-sabr-audio-mime"),
);
if (!muxRes.ok || !muxRes.body) {
  console.error(await muxRes.text());
  process.exit(6);
}

const reader = muxRes.body.getReader();
let total = 0;
let frames = 0;
let videoBytes = 0;
let audioBytes = 0;
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

for (let i = 0; i < 40; i++) {
  const header = await take(5);
  if (!header) break;
  const type = header[0];
  const len = new DataView(header.buffer, header.byteOffset, 5).getUint32(1);
  const payload = len ? await take(len) : new Uint8Array(0);
  if (!payload) break;
  frames++;
  total += 5 + payload.byteLength;
  if (type === 1) videoBytes += payload.byteLength;
  if (type === 2) audioBytes += payload.byteLength;
  if (type === 0) break;
  if (videoBytes > 20000 && audioBytes > 2000) break;
}

try {
  await reader.cancel();
} catch {
  /* ignore */
}

console.log({ frames, total, videoBytes, audioBytes });
if (videoBytes < 1000 || audioBytes < 100) {
  console.error("FAIL: mux did not yield enough video/audio");
  process.exit(7);
}

await fetch(`${BASE}/api/media/youtube/${VIDEO_ID}/sabr/${started.sessionId}`, {
  method: "DELETE",
  headers: { Cookie: cookie, Origin: BASE },
});

console.error("OK: meta prefers progressive; SABR ≥720p in ladder; mux delivered frames");
