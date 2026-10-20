#!/usr/bin/env node
/**
 * Start OwnNote for E2E/API tests: known password ("testpass"), SPA build,
 * wrangler dev on E2E_PORT with isolated D1 persist dir.
 *
 * Applies D1 migrations AFTER wrangler is listening so Miniflare and
 * `d1 migrations apply --persist-to` share the same local DB.
 */
import { spawn, spawnSync } from "node:child_process";
import { webcrypto, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = process.env.E2E_PORT ?? "8799";
const PASSWORD = process.env.E2E_PASSWORD ?? "testpass";
const STATE = resolve(root, ".wrangler/e2e-state");
const wranglerBin = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const viteBin = resolve(root, "node_modules/vite/bin/vite.js");

async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pw),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    key,
    256,
  );
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

async function waitFor(url, ms = 120_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.status > 0) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`[e2e] timed out waiting for ${url}`);
}

if (process.env.E2E_SKIP_BUILD !== "1" || !existsSync(resolve(root, "dist/index.html"))) {
  run([viteBin, "build"], "vite build");
}

try {
  rmSync(STATE, { recursive: true, force: true });
} catch {
  /* ignore Windows locks */
}
mkdirSync(STATE, { recursive: true });

const hash = await hashPassword(PASSWORD);
const wrangler = spawn(
  process.execPath,
  [
    wranglerBin,
    "dev",
    "--port",
    PORT,
    "--ip",
    "127.0.0.1",
    "--persist-to",
    STATE,
    "--var",
    `PASSWORD_HASH:${hash}`,
    "--show-interactive-dev-session=false",
  ],
  { cwd: root, stdio: "inherit" },
);

const stop = () => {
  if (process.platform === "win32" && wrangler.pid) {
    spawnSync("taskkill", ["/pid", String(wrangler.pid), "/T", "/F"]);
  } else {
    wrangler.kill("SIGTERM");
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
wrangler.on("exit", (code) => process.exit(code ?? 0));

try {
  await waitFor(`http://127.0.0.1:${PORT}/`);
  run(
    [
      wranglerBin,
      "d1",
      "migrations",
      "apply",
      "ownnote-db",
      "--local",
      "--persist-to",
      STATE,
    ],
    "d1 migrations",
  );
  console.log(`[e2e] ready on http://127.0.0.1:${PORT}`);
} catch (err) {
  console.error(err);
  stop();
}
