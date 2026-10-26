import { Hono } from "hono";
import { HttpError, type AppEnv } from "../env";
import { nowIso } from "../lib/http";
import { getNoteRow } from "../lib/notes-db";

export const attachments = new Hono<AppEnv>();

// ponytail: D1 row limit ~1MB — raise / move to R2 when ToS can be accepted.
const MAX_BYTES = 900 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type AttachmentRow = {
  id: string;
  note_id: string;
  r2_key: string;
  content_type: string;
  byte_size: number;
  created_at: string;
  data: ArrayBuffer | null;
};

attachments.post("/notes/:id/attachments", async (c) => {
  const noteId = c.req.param("id");
  if (!(await getNoteRow(c.env.DB, noteId))) throw new HttpError(404, "Note not found");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new HttpError(400, "Expected multipart form data");
  }

  // Workers FormData typings omit File; runtime still returns File for multipart parts.
  const entry = form.get("file") as unknown;
  if (entry == null || typeof entry === "string") throw new HttpError(400, "file is required");
  const file = entry as { size: number; type: string; arrayBuffer(): Promise<ArrayBuffer> };
  if (file.size <= 0) throw new HttpError(400, "Empty file");
  if (file.size > MAX_BYTES) {
    throw new HttpError(413, "Image too large (max 900KB without object storage)");
  }

  const contentType = (file.type || "").toLowerCase();
  if (!ALLOWED.has(contentType)) {
    throw new HttpError(400, "Only JPEG, PNG, GIF, or WebP images are allowed");
  }

  const id = crypto.randomUUID();
  // Keep unique key column from 0002; value is not an R2 object path anymore.
  const storageKey = `d1/${noteId}/${id}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) {
    throw new HttpError(413, "Image too large (max 900KB without object storage)");
  }

  const created_at = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO note_attachments (id, note_id, r2_key, content_type, byte_size, created_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, noteId, storageKey, contentType, bytes.byteLength, created_at, bytes)
    .run();

  return c.json({
    id,
    url: `/api/attachments/${id}`,
    content_type: contentType,
    byte_size: bytes.byteLength,
  });
});

attachments.get("/attachments/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT id, note_id, r2_key, content_type, byte_size, created_at, data FROM note_attachments WHERE id = ?`,
  )
    .bind(id)
    .first<AttachmentRow>();
  if (!row) throw new HttpError(404, "Attachment not found");
  if (!row.data || row.data.byteLength === 0) throw new HttpError(404, "Attachment file missing");

  const headers = new Headers();
  headers.set("Content-Type", row.content_type);
  headers.set("Content-Length", String(row.byte_size));
  headers.set("Cache-Control", "private, max-age=3600");
  return new Response(row.data, { status: 200, headers });
});

attachments.delete("/attachments/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(`SELECT id FROM note_attachments WHERE id = ?`)
    .bind(id)
    .first<{ id: string }>();
  if (!row) throw new HttpError(404, "Attachment not found");

  await c.env.DB.prepare(`DELETE FROM note_attachments WHERE id = ?`).bind(id).run();
  return c.body(null, 204);
});
