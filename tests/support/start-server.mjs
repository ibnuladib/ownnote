#!/usr/bin/env node
/**
 * Start OwnNote for E2E/API tests: known password ("testpass"), SPA build,
 * wrangler dev on E2E_PORT with isolated D1 persist dir.
 *
 * Applies D1 migrations AFTER wrangler is listening so Miniflare and
 * `d1 migrations apply --persist-to` share the same local DB.
 *
 * Prints: [e2e] ready on http://127.0.0.1:<port>
 * Exit 0 on SIGINT/SIGTERM. Non-zero only if startup or wrangler crashes.
 */
import { spawn, spawnSync } from "node:child_process";
import { webcrypto, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PREFERRED_PORT = Number(process.env.E2E_PORT ?? 8799);
const PASSWORD = process.env.E2E_PASSWORD ?? "testpass";
const STATE = resolve(root, ".wrangler/e2e-state");
const PORT_FILE = resolve(root, ".wrangler/e2e-port");
const wranglerBin = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const viteBin = resolve(root, "node_modules/vite/bin/vite.js");

let stopping = false;
let wrangler = null;
let PORT = String(PREFERRED_PORT);

function log(...args) {
  console.error("[e2e]", ...args);
}

function isPortFree(port) {
  return new Promise((resolveFree) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolveFree(false));
    server.once("listening", () => {
      server.close(() => resolveFree(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function pickPort(preferred) {
  for (let p = preferred; p < preferred + 40; p++) {
    if (await isPortFree(p)) return String(p);
  }
  throw new Error(`No free port in ${preferred}–${preferred + 39}`);
}

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
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, E2E_PORT: PORT },
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    log(`${label} failed (exit ${r.status})`);
    if (r.error) log(String(r.error));
    process.exit(r.status ?? 1);
  }
}

async function waitFor(url, { ok = () => true, ms = 120_000, label = url } = {}) {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (ok(res)) return res;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${label} (${lastErr})`);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (wrangler?.pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(wrangler.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      wrangler.kill("SIGTERM");
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

try {
  if (process.env.E2E_SKIP_BUILD !== "1" || !existsSync(resolve(root, "dist/index.html"))) {
    log("building SPA…");
    run([viteBin, "build"], "vite build");
  } else {
    log("skipping build (dist present, E2E_SKIP_BUILD=1)");
  }

  PORT = await pickPort(PREFERRED_PORT);
  if (PORT !== String(PREFERRED_PORT)) {
    log(`port ${PREFERRED_PORT} busy — using ${PORT}`);
  }
  process.env.E2E_PORT = PORT;
  mkdirSync(resolve(root, ".wrangler"), { recursive: true });
  writeFileSync(PORT_FILE, PORT, "utf8");

  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch (e) {
    log("could not clear e2e-state (continuing):", e instanceof Error ? e.message : e);
  }
  mkdirSync(STATE, { recursive: true });

  const hash = await hashPassword(PASSWORD);
  log(`starting wrangler on 127.0.0.1:${PORT}`);

  wrangler = spawn(
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
    { cwd: root, stdio: "inherit", env: { ...process.env, E2E_PORT: PORT } },
  );

  wrangler.on("exit", (code, signal) => {
    if (stopping) return;
    log(`wrangler exited unexpectedly (code=${code}, signal=${signal})`);
    process.exit(code ?? 1);
  });

  await waitFor(`http://127.0.0.1:${PORT}/`, { label: "SPA /" });
  log("applying D1 migrations…");
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

  await waitFor(`http://127.0.0.1:${PORT}/api/health`, {
    label: "/api/health",
    ok: (res) => res.status === 200,
  });

  // Distinct from wrangler's "Ready on …" line — wait for THIS marker only.
  console.log(`[e2e] READY http://127.0.0.1:${PORT}`);
} catch (err) {
  log("startup failed:", err instanceof Error ? err.stack || err.message : err);
  stop(1);
}
