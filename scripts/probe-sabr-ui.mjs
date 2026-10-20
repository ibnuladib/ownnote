/**
 * Drive the real SPA: cookie auth → create note with CS229 → play → observe SABR.
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
for (const db of walk(".wrangler/state")) {
  spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addCookies([{ name: "ownnote_session", value: TOKEN, url: BASE }]);
const page = await context.newPage();
const net = [];
page.on("console", (msg) => {
  const t = msg.type();
  if (t === "error" || t === "warning") console.log("BROWSER", t, msg.text());
});
page.on("response", (res) => {
  const u = res.url();
  if (u.includes("/sabr/") || u.includes("/media/youtube")) {
    net.push({ status: res.status(), url: u.replace(BASE, ""), ok: res.ok() });
  }
});

await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector(".watch-wrap, .login-card, .workspace", { timeout: 15000 });

const noteId = await page.evaluate(async (videoId) => {
  // Clear notes for a clean slate is optional; just create one.
  const created = await fetch("/api/notes", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "SABR UI probe" }),
  }).then((r) => r.json());
  const id = created.note.id;
  await fetch(`/api/notes/${id}/videos`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` }),
  });
  return id;
}, VIDEO_ID);

// Click the note in the list if present, else reload with selection via UI navigation.
await page.evaluate((id) => {
  const el = document.querySelector(`[data-note-id="${id}"], [data-id="${id}"]`);
  if (el instanceof HTMLElement) el.click();
}, noteId);
await page.waitForTimeout(500);

// Force-select note by clicking title text.
const noteBtn = page.getByText("SABR UI probe").first();
if (await noteBtn.count()) await noteBtn.click();
await page.waitForTimeout(1500);

// Click play on the player.
const play = page.locator('.player-controls button[aria-label="Play"], .player-poster').first();
await play.click({ timeout: 10000 }).catch(() => {});
console.log("clicked play, waiting for sabr…");

// Wait up to 25s for sabr mux or banner.
for (let i = 0; i < 25; i++) {
  await page.waitForTimeout(1000);
  const banner = await page.locator(".player-banner").textContent().catch(() => null);
  const phase = await page.locator(".player-frame").getAttribute("data-phase");
  if (banner?.includes("Playing") || banner?.includes("Starting") || phase === "direct" || phase === "playing") {
    console.log("status", { i, banner, phase });
    if (banner?.includes("Playing") || phase === "playing" || phase === "direct") break;
  }
}

await page.waitForTimeout(5000);

const snapshot = await page.evaluate(() => {
  const banner = document.querySelector(".player-banner")?.textContent ?? null;
  const phase = document.querySelector(".player-frame")?.getAttribute("data-phase") ?? null;
  const video = document.querySelector("video.player-direct");
  let media = null;
  if (video) {
    const buffered = [];
    try {
      for (let i = 0; i < video.buffered.length; i++) {
        buffered.push({ start: video.buffered.start(i), end: video.buffered.end(i) });
      }
    } catch {
      /* ignore */
    }
    media = {
      paused: video.paused,
      currentTime: video.currentTime,
      readyState: video.readyState,
      networkState: video.networkState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      src: (video.currentSrc || video.src || "").slice(0, 100),
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
      buffered,
    };
  }
  const blocked = document.querySelector(".player-blocked-copy")?.textContent ?? null;
  return { banner, phase, media, blocked };
});

console.log(JSON.stringify({ snapshot, net }, null, 2));
await browser.close();
const ok =
  snapshot.media &&
  snapshot.media.videoWidth >= 720 &&
  (snapshot.media.currentTime > 0 || snapshot.media.buffered?.some((b) => b.end > 1));
process.exit(ok ? 0 : 2);
