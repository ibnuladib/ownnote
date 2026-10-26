import { createServer } from "node:net";
import { defineConfig, devices } from "@playwright/test";

/** Prefer E2E_PORT; if busy, walk upward so webServer URL matches the child. */
async function resolvePort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 40; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.unref();
      s.once("error", () => resolve(false));
      s.once("listening", () => s.close(() => resolve(true)));
      s.listen(p, "127.0.0.1");
    });
    if (free) return p;
  }
  throw new Error(`No free port near ${preferred}`);
}

// Workers re-import this config after webServer binds the port. If we walk for a
// free port again, they pick preferred+1 and baseURL diverges from the server.
const fromEnv = process.env.E2E_PORT;
const preferred = Number(fromEnv ?? 8799);
const PORT = process.env.E2E_BASE_URL || fromEnv
  ? preferred
  : await resolvePort(preferred);
process.env.E2E_PORT = String(PORT);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
  // One shared local D1 + login rate limit => run serially.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Set E2E_BASE_URL to test an already-running server instead.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "node tests/support/start-server.mjs",
        // /api/health is 503 until D1 migrations finish, then 200.
        url: `${BASE_URL}/api/health`,
        ignoreHTTPSErrors: true,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          E2E_PORT: String(PORT),
          E2E_SKIP_BUILD: process.env.E2E_SKIP_BUILD ?? "1",
        },
      },
});
