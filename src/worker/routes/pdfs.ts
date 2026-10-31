import { Hono } from "hono";
import type { NotePdf, PdfStatus } from "../../shared/types";
import { HttpError, type AppEnv } from "../env";
import { copyBytes, toUint8Array } from "../lib/bytes";
import { nowIso, readJson } from "../lib/http";
import { getNoteRow } from "../lib/notes-db";

export const pdfs = new Hono<AppEnv>();

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB across D1 chunks
const CHUNK_BYTES = 750 * 1024; // 750 KB per row (safe under D1's 1 MB statement limit)
const MAX_PDFS_PER_NOTE = 50;
const STATUSES: PdfStatus[] = ["unread", "reading", "done"];

const SELECT_PDF = `SELECT id, note_id, title, byte_size, page_count, current_page, status, created_at FROM note_pdfs`;

function hasPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 5) return false;
  // %PDF- (0x25 0x50 0x44 0x46 0x2D) within first 1024 bytes
  const limit = Math.min(bytes.byteLength - 5, 1024);
  for (let i = 0; i <= limit; i++) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 &&
      bytes[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

/** Fast zero-dependency page count estimator from raw PDF structure. */
function estimatePdfPageCount(bytes: Uint8Array): number {
  try {
    const sample = new TextDecoder("latin1").decode(bytes);
    const matches = sample.match(/\/Type\s*\/Page\b(?!s)/g);
    if (matches && matches.length > 0 && matches.length < 10000) {
      return matches.length;
    }
    const counts = [...sample.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
    const maxCount = counts.length ? Math.max(...counts) : 0;
    if (maxCount > 0 && maxCount < 10000) return maxCount;
  } catch {
    /* fallback to 1 */
  }
  return 1;
}

function cleanPdfTitle(raw: string): string {
  return (
    raw
      .replace(/\.pdf$/i, "")
      .replace(/[_-]+/g, " ")
      .trim()
      .slice(0, 240) || "Untitled PDF"
  );
}

export async function loadPdfs(db: D1Database, noteId?: string): Promise<NotePdf[]> {
  const stmt = noteId
    ? db.prepare(`${SELECT_PDF} WHERE note_id = ? ORDER BY created_at ASC`).bind(noteId)
    : db.prepare(`${SELECT_PDF} ORDER BY note_id, created_at ASC`);
  const { results } = await stmt.all<NotePdf>();
  return results;
}

async function getPdf(db: D1Database, id: string): Promise<NotePdf | null> {
  return db.prepare(`${SELECT_PDF} WHERE id = ?`).bind(id).first<NotePdf>();
}

pdfs.get("/notes/:id/pdfs", async (c) => {
  const noteId = c.req.param("id");
  if (!(await getNoteRow(c.env.DB, noteId))) throw new HttpError(404, "Note not found");
  return c.json({ pdfs: await loadPdfs(c.env.DB, noteId) });
});

pdfs.post("/notes/:id/pdfs", async (c) => {
  const db = c.env.DB;
  const noteId = c.req.param("id");
  if (!(await getNoteRow(db, noteId))) throw new HttpError(404, "Note not found");

  const countRow = await db
    .prepare("SELECT COUNT(*) AS n FROM note_pdfs WHERE note_id = ?")
    .bind(noteId)
    .first<{ n: number }>();
  if ((countRow?.n ?? 0) >= MAX_PDFS_PER_NOTE) {
    throw new HttpError(409, "Too many PDFs on this note");
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw new HttpError(400, "Expected multipart form data");
  }

  const entry = form.get("file") as unknown;
  if (entry == null || typeof entry === "string") throw new HttpError(400, "file is required");
  const file = entry as {
    name?: string;
    size: number;
    type: string;
    arrayBuffer(): Promise<ArrayBuffer>;
  };

  if (file.size <= 0) throw new HttpError(400, "Empty file");
  if (file.size > MAX_PDF_BYTES) {
    throw new HttpError(413, "PDF too large (max 10 MB)");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new HttpError(413, "PDF too large (max 10 MB)");
  }
  if (!hasPdfMagic(bytes)) {
    throw new HttpError(400, "Only valid PDF files are allowed");
  }

  const rawTitle = form.get("title");
  const title =
    typeof rawTitle === "string" && rawTitle.trim()
      ? cleanPdfTitle(rawTitle)
      : cleanPdfTitle(file.name || "Document.pdf");

  const rawPages = Number(form.get("page_count"));
  const pageCount =
    Number.isFinite(rawPages) && rawPages >= 1 && rawPages <= 10000
      ? Math.round(rawPages)
      : estimatePdfPageCount(bytes);

  const id = crypto.randomUUID();
  const created_at = nowIso();

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO note_pdfs (id, note_id, title, byte_size, page_count, current_page, status, created_at)
         VALUES (?, ?, ?, ?, ?, 1, 'unread', ?)`,
      )
      .bind(id, noteId, title, bytes.byteLength, pageCount, created_at),
  ];

  let chunkIdx = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    const end = Math.min(offset + CHUNK_BYTES, bytes.byteLength);
    stmts.push(
      db
        .prepare(`INSERT INTO note_pdf_chunks (pdf_id, chunk_index, data) VALUES (?, ?, ?)`)
        .bind(id, chunkIdx++, copyBytes(bytes.subarray(offset, end))),
    );
  }

  await db.batch(stmts);
  return c.json({ pdf: (await getPdf(db, id))! });
});

pdfs.get("/pdfs/:id/file", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const meta = await getPdf(db, id);
  if (!meta) throw new HttpError(404, "PDF not found");

  const etag = `"pdf-${id}"`;
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "private, max-age=86400, immutable",
      },
    });
  }

  const { results } = await db
    .prepare(`SELECT chunk_index, data FROM note_pdf_chunks WHERE pdf_id = ? ORDER BY chunk_index ASC`)
    .bind(id)
    .all<{ chunk_index: number; data: ArrayBuffer }>();

  if (!results.length) throw new HttpError(404, "PDF data missing");

  const parts = results.map((r) => toUint8Array(r.data));
  const total = parts.reduce((acc, part) => acc + part.byteLength, 0);
  if (total === 0) throw new HttpError(404, "PDF data missing");
  const full = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    full.set(part, pos);
    pos += part.byteLength;
  }

  const safeFilename = meta.title.replace(/[^\w\s.-]/g, "").trim() || "document";
  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${safeFilename}.pdf"`,
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Cache-Control": "private, max-age=86400, immutable",
  });

  const range = c.req.header("range");
  if (range && range.startsWith("bytes=")) {
    const [startStr, endStr] = range.slice(6).split("-");
    const start = startStr ? parseInt(startStr, 10) : 0;
    const end = endStr ? Math.min(total - 1, parseInt(endStr, 10)) : total - 1;
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && start < total) {
      const slice = copyBytes(full.subarray(start, end + 1));
      headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
      headers.set("Content-Length", String(slice.byteLength));
      return new Response(slice, { status: 206, headers });
    }
  }

  headers.set("Content-Length", String(full.byteLength));
  return new Response(full, { status: 200, headers });
});

pdfs.patch("/pdfs/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const existing = await getPdf(db, id);
  if (!existing) throw new HttpError(404, "PDF not found");

  const body = await readJson(c);
  const sets: string[] = [];
  const params: unknown[] = [];

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) {
      throw new HttpError(400, "Invalid title");
    }
    sets.push("title = ?");
    params.push(body.title.trim().slice(0, 240));
  }
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUSES.includes(body.status as PdfStatus)) {
      throw new HttpError(400, "Invalid status");
    }
    sets.push("status = ?");
    params.push(body.status);
  }
  if (body.page_count !== undefined) {
    const pc = Number(body.page_count);
    if (!Number.isFinite(pc) || pc < 1 || pc > 10000) {
      throw new HttpError(400, "Invalid page_count");
    }
    sets.push("page_count = ?");
    params.push(Math.round(pc));
  }
  if (body.current_page !== undefined) {
    const cp = Number(body.current_page);
    if (!Number.isFinite(cp) || cp < 1 || cp > 10000) {
      throw new HttpError(400, "Invalid current_page");
    }
    sets.push("current_page = ?");
    params.push(Math.round(cp));
  }

  if (sets.length) {
    await db
      .prepare(`UPDATE note_pdfs SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...params, id)
      .run();
  }
  return c.json({ pdf: (await getPdf(db, id))! });
});

pdfs.delete("/pdfs/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM note_pdfs WHERE id = ?").bind(c.req.param("id")).run();
  if (!res.meta.changes) throw new HttpError(404, "PDF not found");
  return c.body(null, 204);
});
