import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { HttpError, type AppEnv } from "../env";
import { randomToken, sha256Hex, verifyPassword } from "../lib/crypto";
import { readJson } from "../lib/http";

export const COOKIE_NAME = "ownnote_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILED = 5;
const WINDOW_MS = 15 * 60 * 1000;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Reject cross-origin state-changing requests. */
export const originCheck: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (MUTATING.has(c.req.method)) {
    const origin = c.req.header("origin");
    const self = new URL(c.req.url).origin;
    if (origin !== undefined) {
      if (origin !== self) throw new HttpError(403, "Cross-origin request blocked");
    } else if (c.req.header("sec-fetch-site") === "cross-site") {
      throw new HttpError(403, "Cross-origin request blocked");
    }
  }
  await next();
};

function cookieSecure(url: string): boolean {
  const u = new URL(url);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return !(local && u.protocol === "http:");
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.path === "/api/login" || c.req.path === "/api/logout" || c.req.path === "/api/health") {
    return next();
  }
  const token = getCookie(c, COOKIE_NAME);
  if (!token || token.length > 200) throw new HttpError(401, "Unauthorized");
  const id = await sha256Hex(token);
  const row = await c.env.DB.prepare("SELECT id FROM sessions WHERE id = ? AND expires_at > ?")
    .bind(id, Date.now())
    .first();
  if (!row) throw new HttpError(401, "Unauthorized");
  await next();
};

export const auth = new Hono<AppEnv>();

auth.post("/login", async (c) => {
  const db = c.env.DB;
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const now = Date.now();

  const recent = await db
    .prepare("SELECT COUNT(*) AS n, MIN(attempted_at) AS oldest FROM login_attempts WHERE ip = ? AND attempted_at > ?")
    .bind(ip, now - WINDOW_MS)
    .first<{ n: number; oldest: number | null }>();
  if ((recent?.n ?? 0) >= MAX_FAILED) {
    const retry = Math.max(1, Math.ceil(((recent?.oldest ?? now) + WINDOW_MS - now) / 1000));
    throw new HttpError(429, "Too many attempts. Try again later.", { "Retry-After": String(retry) });
  }

  const body = await readJson(c);
  const password = body.password;
  if (typeof password !== "string" || password.length === 0 || password.length > 1024) {
    throw new HttpError(401, "Invalid password");
  }
  const stored = c.env.PASSWORD_HASH;
  if (!stored) throw new HttpError(500, "Server not configured");

  if (!(await verifyPassword(password, stored))) {
    await db.prepare("INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)").bind(ip, now).run();
    throw new HttpError(401, "Invalid password");
  }

  const token = randomToken();
  const id = await sha256Hex(token);
  await db.batch([
    db.prepare("DELETE FROM login_attempts WHERE ip = ? OR attempted_at < ?").bind(ip, now - WINDOW_MS),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db
      .prepare("INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)")
      .bind(id, new Date(now).toISOString(), now + SESSION_TTL_MS),
  ]);

  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: cookieSecure(c.req.url),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return c.body(null, 204);
});

auth.post("/logout", async (c) => {
  const token = getCookie(c, COOKIE_NAME);
  if (token && token.length <= 200) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(token)).run();
  }
  deleteCookie(c, COOKIE_NAME, { path: "/", secure: cookieSecure(c.req.url) });
  return c.body(null, 204);
});

auth.get("/me", (c) => c.json({ ok: true }));
