import { Hono } from "hono";
import { HttpError, type AppEnv } from "../env";
import { toUint8Array } from "../lib/bytes";
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
  const etag = `"att-${id}"`;

  if (c.req.header("if-none-match") === etag) {
    const exists = await c.env.DB.prepare(`SELECT 1 AS x FROM note_attachments WHERE id = ?`)
      .bind(id)
      .first();
    if (exists) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "private, max-age=86400, immutable",
        },
      });
    }
  }

  const row = await c.env.DB.prepare(
    `SELECT id, note_id, r2_key, content_type, byte_size, created_at, data FROM note_attachments WHERE id = ?`,
  )
    .bind(id)
    .first<AttachmentRow>();
  if (!row) throw new HttpError(404, "Attachment not found");
  let bytes = toUint8Array(row.data);
  if (bytes.byteLength === 0) {
    const { results } = await c.env.DB.prepare(
      `SELECT data FROM note_attachment_chunks WHERE attachment_id = ? ORDER BY chunk_index ASC`,
    )
      .bind(id)
      .all<{ data: unknown }>();
    const parts = results.map((r) => toUint8Array(r.data)).filter((p) => p.byteLength > 0);
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    if (!total) throw new HttpError(404, "Attachment file missing");
    bytes = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
      bytes.set(part, pos);
      pos += part.byteLength;
    }
  }

  const headers = new Headers();
  headers.set("Content-Type", row.content_type);
  headers.set("Content-Length", String(bytes.byteLength));
  headers.set("ETag", etag);
  headers.set("Cache-Control", "private, max-age=86400, immutable");
  return new Response(bytes, { status: 200, headers });
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
