import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const VIDEO_ID = process.argv[2] || "9vM4p9NN0Ts";
const POS = Number(process.argv[3] || 3333);
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
VALUES ('${VIDEO_ID}', ${POS}, 4800, '${created}');
`;
for (const db of walk(".wrangler/state")) {
  const r = spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
  console.log(db, r.status === 0 ? `watch=${POS}` : r.stderr);
}
