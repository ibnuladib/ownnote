/**
 * Set watch progress far ahead, play via SPA, confirm we start from 0 (or play)
 * instead of seeking into empty SABR buffers.
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

const sql = `
INSERT OR REPLACE INTO sessions (id, created_at, expires_at) VALUES ('${sessionIdHash}', '${created}', ${exp});
INSERT OR REPLACE INTO watch_progress (youtube_id, position_seconds, duration_seconds, updated_at)
VALUES ('${VIDEO_ID}', 3333, 4800, '${created}');
`;
for (const db of walk(".wrangler/state")) {
  spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addCookies([{ name: "ownnote_session", value: TOKEN, url: BASE }]);
const page = await context.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("BROWSER error", msg.text());
});

await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".watch-wrap, .workspace, .login-card", { timeout: 20000 });

const noteId = await page.evaluate(async (videoId) => {
  const created = await fetch("/api/notes", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "SABR resume probe" }),
  }).then((r) => r.json());
  await fetch(`/api/notes/${created.note.id}/videos`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` }),
  });
  return created.note.id;
}, VIDEO_ID);

// Reload so the note list picks up the new note, then open it.
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".watch-wrap, .workspace", { timeout: 20000 });
await page.getByText("SABR resume probe").first().click({ timeout: 15000 });
await page.waitForTimeout(2500);
// Confirm the fixture video is selected.
const hasVideo = await page.locator(".player-frame").count();
if (!hasVideo) {
  console.error("no player frame after selecting note", noteId);
  process.exit(3);
}
await page.locator('.player-controls button[aria-label="Play"], .player-poster').first().click();

let last = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  last = await page.evaluate(() => {
    const banner = document.querySelector(".player-banner")?.textContent ?? null;
    const phase = document.querySelector(".player-frame")?.getAttribute("data-phase") ?? null;
    const video = document.querySelector("video.player-direct");
    if (!video) return { banner, phase, media: null };
    const buffered = [];
    try {
      for (let j = 0; j < video.buffered.length; j++) {
        buffered.push({ start: video.buffered.start(j), end: video.buffered.end(j) });
      }
    } catch {
      /* ignore */
    }
    return {
      banner,
      phase,
      media: {
        paused: video.paused,
        currentTime: video.currentTime,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        buffered,
      },
    };
  });
  console.log("tick", i, {
    banner: last.banner,
    phase: last.phase,
    t: last.media?.currentTime,
    paused: last.media?.paused,
    wh: last.media?.videoWidth,
    buf: last.media?.buffered,
  });
  if (
    last.media &&
    last.media.videoWidth >= 720 &&
    last.media.currentTime > 0.2 &&
    last.media.currentTime < 120 &&
    !last.media.paused &&
    last.media.buffered?.some((b) => b.end > 0.5)
  ) {
    break;
  }
}

console.log(JSON.stringify(last, null, 2));
await browser.close();

const ok =
  last?.media &&
  last.media.videoWidth >= 720 &&
  last.media.currentTime > 0.2 &&
  last.media.currentTime < 120 &&
  !last.media.paused &&
  (last.media.buffered?.some((b) => b.end > 0.5) ?? false);
process.exit(ok ? 0 : 2);
