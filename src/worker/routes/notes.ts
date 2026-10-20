import { Hono } from "hono";
import { contentForTemplate, TEMPLATES } from "../../shared/templates";
import { HttpError, type AppEnv } from "../env";
import { cleanTitle, isPlainObject, nowIso, readJson } from "../lib/http";
import {
  NOTE_ORDER,
  deleteFts,
  getNoteRow,
  loadTags,
  searchTextFor,
  syncFts,
  toNote,
  toSummary,
  type NoteRow,
} from "../lib/notes-db";
import { EMPTY_DOC } from "../lib/tiptap";

export const notes = new Hono<AppEnv>();

const MAX_TAGS_PER_NOTE = 30;

async function insertNote(
  db: D1Database,
  opts: { title: string; content: Record<string, unknown>; template_key: string | null },
): Promise<NoteRow> {
  const id = crypto.randomUUID();
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO notes (id, title, content, search_text, template_key, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(id, opts.title, JSON.stringify(opts.content), searchTextFor(opts.content), opts.template_key, ts, ts)
    .run();
  await syncFts(db, id);
  return (await getNoteRow(db, id))!;
}

notes.get("/notes", async (c) => {
  const tag = c.req.query("tag");
  const params: unknown[] = [];
  let where = "";
  if (tag) {
    where = "WHERE EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND t.name = ?)";
    params.push(tag.trim());
  }
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.title, n.pinned, n.pinned_at, n.last_opened_at, n.updated_at FROM notes n ${where} ORDER BY ${NOTE_ORDER}`,
  )
    .bind(...params)
    .all<NoteRow>();
  const tags = await loadTags(c.env.DB);
  return c.json({ notes: results.map((r) => toSummary(r, tags.get(r.id) ?? [])) });
});

notes.post("/notes", async (c) => {
  const body = await readJson(c);
  const title = body.title === undefined ? "Untitled" : cleanTitle(body.title);
  if (body.content !== undefined && !isPlainObject(body.content)) throw new HttpError(400, "content must be an object");
  const row = await insertNote(c.env.DB, {
    title,
    content: (body.content as Record<string, unknown> | undefined) ?? EMPTY_DOC,
    template_key: null,
  });
  return c.json({ note: toNote(row, []) });
});

notes.post("/notes/from-template", async (c) => {
  const body = await readJson(c);
  const key = body.key;
  const meta = typeof key === "string" ? TEMPLATES.find((t) => t.key === key) : undefined;
  if (!meta) throw new HttpError(400, "Unknown template key");
  const title = body.title === undefined ? meta.name : cleanTitle(body.title, meta.name);
  const content = contentForTemplate(meta.key, title);
  if (!content) throw new HttpError(400, "Unknown template key");
  const row = await insertNote(c.env.DB, { title, content, template_key: meta.key });
  return c.json({ note: toNote(row, []) });
});

notes.get("/notes/:id", async (c) => {
  const id = c.req.param("id");
  const ts = nowIso();
  await c.env.DB.prepare("UPDATE notes SET last_opened_at = ? WHERE id = ?").bind(ts, id).run();
  const row = await getNoteRow(c.env.DB, id);
  if (!row) throw new HttpError(404, "Note not found");
  const tags = await loadTags(c.env.DB, [id]);
  return c.json({ note: toNote(row, tags.get(id) ?? []) });
});

notes.patch("/notes/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const existing = await getNoteRow(db, id);
  if (!existing) throw new HttpError(404, "Note not found");
  const body = await readJson(c);

  const sets: string[] = [];
  const params: unknown[] = [];
  const ts = nowIso();
  let contentChanged = false;

  if (body.title !== undefined) {
    sets.push("title = ?");
    params.push(cleanTitle(body.title));
    contentChanged = true;
  }
  if (body.content !== undefined) {
    if (!isPlainObject(body.content)) throw new HttpError(400, "content must be an object");
    sets.push("content = ?", "search_text = ?");
    params.push(JSON.stringify(body.content), searchTextFor(body.content));
    contentChanged = true;
  }
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== "boolean") throw new HttpError(400, "pinned must be a boolean");
    sets.push("pinned = ?", "pinned_at = ?");
    params.push(body.pinned ? 1 : 0, body.pinned ? (existing.pinned ? existing.pinned_at : ts) : null);
  }
  if (contentChanged) {
    sets.push("updated_at = ?");
    params.push(ts);
  }
  if (sets.length) {
    await db
      .prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...params, id)
      .run();
    if (contentChanged) await syncFts(db, id);
  }
  const row = (await getNoteRow(db, id))!;
  const tags = await loadTags(db, [id]);
  return c.json({ note: toNote(row, tags.get(id) ?? []) });
});

notes.delete("/notes/:id", async (c) => {
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, "Note not found");
  await deleteFts(c.env.DB, id);
  return c.body(null, 204);
});

notes.put("/notes/:id/tags", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  if (!(await getNoteRow(db, id))) throw new HttpError(404, "Note not found");
  const body = await readJson(c);
  if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== "string")) {
    throw new HttpError(400, "tags must be an array of strings");
  }
  // normalize: trim, drop empties, case-insensitive dedupe
  const seen = new Map<string, string>();
  for (const raw of body.tags as string[]) {
    const name = raw.trim().replace(/\s+/g, " ").slice(0, 50);
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  const names = [...seen.values()];
  if (names.length > MAX_TAGS_PER_NOTE) throw new HttpError(400, `At most ${MAX_TAGS_PER_NOTE} tags per note`);

  // INSERT OR IGNORE respects UNIQUE COLLATE NOCASE on name
  const stmts = [
    db.prepare("DELETE FROM note_tags WHERE note_id = ?").bind(id),
    ...names.map((n) => db.prepare("INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)").bind(crypto.randomUUID(), n)),
    ...names.map((n) =>
      db
        .prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_id) SELECT ?, id FROM tags WHERE name = ?")
        .bind(id, n),
    ),
    // garbage-collect orphan tags
    db.prepare("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM note_tags)"),
  ];
  await db.batch(stmts);
  const tags = await loadTags(db, [id]);
  return c.json({ tags: tags.get(id) ?? [] });
});
