import { Hono } from "hono";
import { HttpError, type AppEnv } from "../env";
import { nowIso } from "../lib/http";
import { getNoteRow } from "../lib/notes-db";

export const attachments = new Hono<AppEnv>();

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

type AttachmentRow = {
  id: string;
  note_id: string;
  r2_key: string;
  content_type: string;
  byte_size: number;
  created_at: string;
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

  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "file is required");
  if (file.size <= 0) throw new HttpError(400, "Empty file");
  if (file.size > MAX_BYTES) throw new HttpError(413, "Image too large (max 5MB)");

  const contentType = (file.type || "").toLowerCase();
  if (!ALLOWED.has(contentType)) {
    throw new HttpError(400, "Only JPEG, PNG, GIF, or WebP images are allowed");
  }

  const id = crypto.randomUUID();
  const r2Key = `images/${noteId}/${id}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new HttpError(413, "Image too large (max 5MB)");

  await c.env.ATTACHMENTS.put(r2Key, bytes, {
    httpMetadata: { contentType },
  });

  const created_at = nowIso();
  try {
    await c.env.DB.prepare(
      `INSERT INTO note_attachments (id, note_id, r2_key, content_type, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, noteId, r2Key, contentType, bytes.byteLength, created_at)
      .run();
  } catch (err) {
    await c.env.ATTACHMENTS.delete(r2Key).catch(() => undefined);
    throw err;
  }

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
    `SELECT id, note_id, r2_key, content_type, byte_size, created_at FROM note_attachments WHERE id = ?`,
  )
    .bind(id)
    .first<AttachmentRow>();
  if (!row) throw new HttpError(404, "Attachment not found");

  const obj = await c.env.ATTACHMENTS.get(row.r2_key);
  if (!obj) throw new HttpError(404, "Attachment file missing");

  const headers = new Headers();
  headers.set("Content-Type", row.content_type);
  headers.set("Content-Length", String(row.byte_size));
  headers.set("Cache-Control", "private, max-age=3600");
  return new Response(obj.body, { status: 200, headers });
});

attachments.delete("/attachments/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT id, r2_key FROM note_attachments WHERE id = ?`,
  )
    .bind(id)
    .first<{ id: string; r2_key: string }>();
  if (!row) throw new HttpError(404, "Attachment not found");

  await c.env.DB.prepare(`DELETE FROM note_attachments WHERE id = ?`).bind(id).run();
  await c.env.ATTACHMENTS.delete(row.r2_key).catch(() => undefined);
  return c.body(null, 204);
});
