#!/usr/bin/env node
/**
 * Start OwnNote for E2E/API tests: fresh local D1 (isolated persist dir), known
 * password ("testpass"), freshly built SPA, wrangler dev on E2E_PORT.
 *
 * Does NOT touch the developer's .dev.vars / .wrangler/state: the hash is passed with
 * --var and state lives in .wrangler/e2e-state (wiped on every run).
 */
import { spawn, spawnSync } from "node:child_process";
import { webcrypto, randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = process.env.E2E_PORT ?? "8799";
const PASSWORD = process.env.E2E_PASSWORD ?? "testpass";
// Unique dir per run: a stale workerd from a killed run can keep the previous one locked on Windows.
const STATE = resolve(root, ".wrangler/e2e-state", String(Date.now()));
const wranglerBin = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const viteBin = resolve(root, "node_modules/vite/bin/vite.js");

async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256);
  const b64 = (b) => Buffer.from(b).toString("base64url");
  return `pbkdf2-sha256:100000:${b64(salt)}:${b64(new Uint8Array(bits))}`;
}

function run(args, label) {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[e2e] ${label} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

if (process.env.E2E_SKIP_BUILD !== "1" || !existsSync(resolve(root, "dist/index.html"))) {
  run([viteBin, "build"], "vite build");
}
try {
  rmSync(resolve(root, ".wrangler/e2e-state"), { recursive: true, force: true }); // old runs, best effort
} catch {}
run(
  [wranglerBin, "d1", "migrations", "apply", "ownnote-db", "--local", "--persist-to", STATE],
  "d1 migrations",
);

const hash = await hashPassword(PASSWORD);
const child = spawn(
  process.execPath,
  [
    wranglerBin, "dev",
    "--port", PORT,
    "--ip", "127.0.0.1",
    "--persist-to", STATE,
    "--var", `PASSWORD_HASH:${hash}`,
    "--show-interactive-dev-session=false",
  ],
  { cwd: root, stdio: "inherit" },
);
const stop = () => {
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
