#!/usr/bin/env node
/**
 * Generate a PASSWORD_HASH for OwnNote.
 *
 * Usage:
 *   npm run hash-password -- "my password"
 *   node scripts/hash-password.mjs            (prompts, input hidden)
 *   echo "my password" | node scripts/hash-password.mjs
 *
 * Output format (parsed by src/worker/lib/crypto.ts):
 *   pbkdf2-sha256:<iterations>:<salt base64url>:<hash base64url>
 *
 * Iterations are capped at 100000 because Cloudflare Workers' Web Crypto
 * rejects PBKDF2 iteration counts above that.
 */
import { webcrypto, randomBytes } from "node:crypto";

const ITERATIONS = 100_000;
const KEY_BYTES = 32;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

async function hash(password) {
  const salt = randomBytes(16);
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    key,
    KEY_BYTES * 8,
  );
  return `pbkdf2-sha256:${ITERATIONS}:${b64url(salt)}:${b64url(new Uint8Array(bits))}`;
}

function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

let password = process.argv[2];
if (password === undefined) {
  password = process.stdin.isTTY ? await readHidden("Password: ") : await readStdin();
}
if (!password || password.length < 8) {
  console.error("Error: password must be at least 8 characters.");
  process.exit(1);
}

const result = await hash(password);
console.log(`\nPASSWORD_HASH=${result}\n`);
console.error("Local dev : add the line above to .dev.vars");
console.error("Production: npx wrangler secret put PASSWORD_HASH   (paste only the value after '=')");
