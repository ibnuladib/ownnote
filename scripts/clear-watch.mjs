import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const VIDEO_ID = process.argv[2] || "9vM4p9NN0Ts";
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
DELETE FROM watch_progress WHERE youtube_id='${VIDEO_ID}';
INSERT OR REPLACE INTO sessions (id, created_at, expires_at) VALUES ('${sessionIdHash}', '${created}', ${exp});
`;
for (const db of walk(".wrangler/state")) {
  const r = spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
  console.log(db, r.status, r.stderr || r.stdout || "ok");
}
