import type { Note, NoteSummary, TipTapJSON } from "../../shared/types";
import { EMPTY_DOC, extractText } from "./tiptap";

export type NoteRow = {
  id: string;
  title: string;
  content: string;
  search_text: string;
  template_key: string | null;
  pinned: number;
  pinned_at: string | null;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
};

export const NOTE_ORDER = "n.pinned DESC, n.pinned_at DESC, n.updated_at DESC";

export function toSummary(r: NoteRow, tags: string[]): NoteSummary {
  return {
    id: r.id,
    title: r.title,
    pinned: r.pinned === 1,
    pinned_at: r.pinned_at,
    last_opened_at: r.last_opened_at,
    updated_at: r.updated_at,
    tags,
  };
}

export function parseContent(raw: string): TipTapJSON {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as TipTapJSON) : EMPTY_DOC;
  } catch {
    return EMPTY_DOC;
  }
}

export function toNote(r: NoteRow, tags: string[]): Note {
  return {
    ...toSummary(r, tags),
    content: parseContent(r.content),
    template_key: r.template_key,
    created_at: r.created_at,
  };
}

/** note_id -> tag names (sorted), for all notes or a given id list */
export async function loadTags(db: D1Database, noteIds?: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const { results } = await db
    .prepare(
      `SELECT nt.note_id AS note_id, t.name AS name FROM note_tags nt
       JOIN tags t ON t.id = nt.tag_id ORDER BY t.name COLLATE NOCASE`,
    )
    .all<{ note_id: string; name: string }>();
  const wanted = noteIds ? new Set(noteIds) : null;
  for (const r of results) {
    if (wanted && !wanted.has(r.note_id)) continue;
    const arr = map.get(r.note_id);
    if (arr) arr.push(r.name);
    else map.set(r.note_id, [r.name]);
  }
  return map;
}

export async function getNoteRow(db: D1Database, id: string): Promise<NoteRow | null> {
  return db.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
}

export function searchTextFor(content: unknown): string {
  return extractText(content).slice(0, 200_000);
}

/** Keep FTS index in sync. Failures never break note writes (search falls back to LIKE). */
export async function syncFts(db: D1Database, id: string): Promise<void> {
  try {
    await db.batch([
      db.prepare("DELETE FROM notes_fts WHERE note_id = ?").bind(id),
      db
        .prepare("INSERT INTO notes_fts (title, body, note_id) SELECT title, search_text, id FROM notes WHERE id = ?")
        .bind(id),
    ]);
  } catch {
    /* FTS unavailable */
  }
}

export async function deleteFts(db: D1Database, id: string): Promise<void> {
  try {
    await db.prepare("DELETE FROM notes_fts WHERE note_id = ?").bind(id).run();
  } catch {
    /* FTS unavailable */
  }
}
