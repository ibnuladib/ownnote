import { Hono } from "hono";
import { TEMPLATES } from "../../shared/templates";
import type { Note, NoteVideo, UserPrefs } from "../../shared/types";
import { HttpError, type AppEnv } from "../env";
import { readJson } from "../lib/http";
import { NOTE_ORDER, loadTags, toNote, toSummary, type NoteRow } from "../lib/notes-db";
import { toMarkdown } from "../lib/tiptap";
import { loadVideos } from "./videos";

export const misc = new Hono<AppEnv>();

const YT_ID = /^[\w-]{11}$/;

/* ---------- templates / tags ---------- */

misc.get("/templates", (c) => c.json({ templates: TEMPLATES }));

misc.get("/tags", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name FROM tags ORDER BY name COLLATE NOCASE").all<{
    id: string;
    name: string;
  }>();
  return c.json({ tags: results });
});

/* ---------- search ---------- */

function ftsQuery(q: string): string | null {
  const terms = q.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12);
  if (!terms?.length) return null;
  return terms.map((t) => `"${t}"*`).join(" ");
}

misc.get("/search", async (c) => {
  const db = c.env.DB;
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  const tag = c.req.query("tag")?.trim();
  if (!q) return c.json({ notes: [] });

  const tagClause = tag
    ? "AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND t.name = ?)"
    : "";
  const cols = "n.id, n.title, n.pinned, n.pinned_at, n.last_opened_at, n.updated_at";

  let rows: NoteRow[] | null = null;
  const match = ftsQuery(q);
  if (match) {
    try {
      const params: unknown[] = [match];
      if (tag) params.push(tag);
      const res = await db
        .prepare(
          `SELECT ${cols} FROM notes n
           WHERE n.id IN (SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?) ${tagClause}
           ORDER BY ${NOTE_ORDER}`,
        )
        .bind(...params)
        .all<NoteRow>();
      rows = res.results;
    } catch {
      rows = null; // FTS unavailable -> LIKE fallback
    }
  }
  if (rows === null) {
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const params: unknown[] = [like, like];
    if (tag) params.push(tag);
    const res = await db
      .prepare(
        `SELECT ${cols} FROM notes n
         WHERE (n.title LIKE ? ESCAPE '\\' OR n.search_text LIKE ? ESCAPE '\\') ${tagClause}
         ORDER BY ${NOTE_ORDER}`,
      )
      .bind(...params)
      .all<NoteRow>();
    rows = res.results;
  }
  const tags = await loadTags(db);
  return c.json({ notes: rows.map((r) => toSummary(r, tags.get(r.id) ?? [])) });
});

/* ---------- prefs ---------- */

async function loadPrefs(db: D1Database): Promise<UserPrefs> {
  const r = await db
    .prepare("SELECT last_note_id, last_video_id FROM user_prefs WHERE id = 1")
    .first<UserPrefs>();
  return { last_note_id: r?.last_note_id ?? null, last_video_id: r?.last_video_id ?? null };
}

misc.get("/prefs", async (c) => c.json(await loadPrefs(c.env.DB)));

misc.put("/prefs", async (c) => {
  const db = c.env.DB;
  const body = await readJson(c);
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, table] of [
    ["last_note_id", "notes"],
    ["last_video_id", "note_videos"],
  ] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (v !== null) {
      if (typeof v !== "string") throw new HttpError(400, `${key} must be a string or null`);
      const exists = await db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?`).bind(v).first();
      if (!exists) throw new HttpError(404, `${key} not found`);
    }
    sets.push(`${key} = ?`);
    params.push(v);
  }
  if (sets.length) {
    await db.prepare(`UPDATE user_prefs SET ${sets.join(", ")} WHERE id = 1`).bind(...params).run();
  }
  return c.json(await loadPrefs(db));
});

/* ---------- watch progress ---------- */

type WatchRow = { position_seconds: number; duration_seconds: number | null };

function checkYtId(id: string) {
  if (!YT_ID.test(id)) throw new HttpError(400, "Invalid YouTube id");
}

misc.get("/watch/:youtubeId", async (c) => {
  const id = c.req.param("youtubeId");
  checkYtId(id);
  const r = await c.env.DB.prepare("SELECT position_seconds, duration_seconds FROM watch_progress WHERE youtube_id = ?")
    .bind(id)
    .first<WatchRow>();
  return c.json({ position_seconds: r?.position_seconds ?? 0, duration_seconds: r?.duration_seconds ?? null });
});

misc.put("/watch/:youtubeId", async (c) => {
  const id = c.req.param("youtubeId");
  checkYtId(id);
  const body = await readJson(c);
  const pos = body.position_seconds;
  if (typeof pos !== "number" || !Number.isFinite(pos) || pos < 0 || pos > 1e7) {
    throw new HttpError(400, "position_seconds must be a non-negative number");
  }
  let dur: number | null | undefined;
  if (body.duration_seconds !== undefined && body.duration_seconds !== null) {
    const d = body.duration_seconds;
    if (typeof d !== "number" || !Number.isFinite(d) || d < 0 || d > 1e7) {
      throw new HttpError(400, "duration_seconds must be a non-negative number");
    }
    dur = d;
  }
  // duration kept when not supplied
  await c.env.DB.prepare(
    `INSERT INTO watch_progress (youtube_id, position_seconds, duration_seconds, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (youtube_id) DO UPDATE SET
       position_seconds = excluded.position_seconds,
       duration_seconds = COALESCE(excluded.duration_seconds, watch_progress.duration_seconds),
       updated_at = excluded.updated_at`,
  )
    .bind(id, pos, dur ?? null, new Date().toISOString())
    .run();
  const r = await c.env.DB.prepare("SELECT position_seconds, duration_seconds FROM watch_progress WHERE youtube_id = ?")
    .bind(id)
    .first<WatchRow>();
  return c.json({ position_seconds: r?.position_seconds ?? pos, duration_seconds: r?.duration_seconds ?? null });
});

/* ---------- export ---------- */

misc.get("/export", async (c) => {
  const db = c.env.DB;
  const format = c.req.query("format") ?? "json";
  if (format !== "json" && format !== "markdown") throw new HttpError(400, "format must be json or markdown");

  const { results } = await db
    .prepare(`SELECT * FROM notes n ORDER BY ${NOTE_ORDER}`)
    .all<NoteRow>();
  const tags = await loadTags(db);
  const videos = await loadVideos(db);
  const exported: (Note & { videos: NoteVideo[] })[] = results.map((r) => ({
    ...toNote(r, tags.get(r.id) ?? []),
    videos: videos.filter((v) => v.note_id === r.id),
  }));
  const date = new Date().toISOString().slice(0, 10);

  if (format === "json") {
    return new Response(JSON.stringify({ exported_at: new Date().toISOString(), version: 1, notes: exported }, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="ownnote-export-${date}.json"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const md = exported
    .map((n) => {
      const parts = [`# ${n.title}`];
      const meta: string[] = [];
      if (n.tags.length) meta.push(`Tags: ${n.tags.map((t) => `#${t.replace(/\s+/g, "-")}`).join(" ")}`);
      meta.push(`Updated: ${n.updated_at}`);
      parts.push(meta.join("  \n"));
      const body = toMarkdown(n.content);
      if (body) parts.push(body);
      if (n.videos.length) {
        const mark = { unwatched: " ", in_progress: "~", done: "x" } as const;
        parts.push(
          "## Videos\n\n" + n.videos.map((v) => `- [${mark[v.status]}] [${v.title}](${v.url})`).join("\n"),
        );
      }
      return parts.join("\n\n");
    })
    .join("\n\n---\n\n");
  return new Response(md + "\n", {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="ownnote-export-${date}.md"`,
      "Cache-Control": "no-store",
    },
  });
});
