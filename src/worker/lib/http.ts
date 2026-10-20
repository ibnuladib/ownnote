import type { Context } from "hono";
import { HttpError } from "../env";
import type { AppEnv } from "../env";

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    throw new HttpError(400, "Invalid body");
  }
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export const nowIso = () => new Date().toISOString();

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function cleanTitle(v: unknown, fallback = "Untitled"): string {
  if (typeof v !== "string") throw new HttpError(400, "title must be a string");
  const t = v.trim().slice(0, 300);
  return t || fallback;
}

export function sqlPlaceholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}
