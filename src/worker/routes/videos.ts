import { Hono } from "hono";
import { extractYoutubeId, youtubeWatchUrl } from "../../shared/youtube";
import type { NoteVideo, VideoStatus } from "../../shared/types";
import { HttpError, type AppEnv } from "../env";
import { readJson } from "../lib/http";
import { getNoteRow } from "../lib/notes-db";

export const videos = new Hono<AppEnv>();

const STATUSES: VideoStatus[] = ["unwatched", "in_progress", "done"];
const MAX_VIDEOS_PER_NOTE = 200;

type VideoRow = Omit<NoteVideo, "position_seconds" | "duration_seconds"> & {
  position_seconds: number | null;
  duration_seconds: number | null;
};

const SELECT = `SELECT v.id, v.note_id, v.youtube_id, v.title, v.url, v.sort_order, v.status, v.created_at,
  w.position_seconds AS position_seconds, w.duration_seconds AS duration_seconds
  FROM note_videos v LEFT JOIN watch_progress w ON w.youtube_id = v.youtube_id`;

function toVideo(r: VideoRow): NoteVideo {
  return { ...r, position_seconds: r.position_seconds ?? 0, duration_seconds: r.duration_seconds ?? null };
}

/** Videos for one note (ordered), or all videos when noteId omitted. */
export async function loadVideos(db: D1Database, noteId?: string): Promise<NoteVideo[]> {
  const stmt = noteId
    ? db.prepare(`${SELECT} WHERE v.note_id = ? ORDER BY v.sort_order, v.created_at`).bind(noteId)
    : db.prepare(`${SELECT} ORDER BY v.note_id, v.sort_order, v.created_at`);
  const { results } = await stmt.all<VideoRow>();
  return results.map(toVideo);
}

async function getVideo(db: D1Database, id: string): Promise<NoteVideo | null> {
  const r = await db.prepare(`${SELECT} WHERE v.id = ?`).bind(id).first<VideoRow>();
  return r ? toVideo(r) : null;
}

async function fetchYoutubeTitle(id: string): Promise<string | null> {
  try {
    const target = `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeWatchUrl(id))}&format=json`;
    const res = await fetch(target, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: unknown };
    return typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}

videos.get("/notes/:id/videos", async (c) => {
  const noteId = c.req.param("id");
  if (!(await getNoteRow(c.env.DB, noteId))) throw new HttpError(404, "Note not found");
  return c.json({ videos: await loadVideos(c.env.DB, noteId) });
});

videos.post("/notes/:id/videos", async (c) => {
  const db = c.env.DB;
  const noteId = c.req.param("id");
  if (!(await getNoteRow(db, noteId))) throw new HttpError(404, "Note not found");
  const body = await readJson(c);
  if (typeof body.url !== "string" || body.url.length > 2000) throw new HttpError(400, "url is required");
  const ytId = extractYoutubeId(body.url);
  if (!ytId) throw new HttpError(400, "Not a valid YouTube URL");

  const info = await db
    .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(sort_order), -1) AS max_order FROM note_videos WHERE note_id = ?")
    .bind(noteId)
    .first<{ n: number; max_order: number }>();
  if ((info?.n ?? 0) >= MAX_VIDEOS_PER_NOTE) throw new HttpError(409, "Too many videos on this note");
  const dup = await db
    .prepare("SELECT 1 AS x FROM note_videos WHERE note_id = ? AND youtube_id = ?")
    .bind(noteId, ytId)
    .first();
  if (dup) throw new HttpError(409, "Video already added to this note");

  const title = (await fetchYoutubeTitle(ytId)) ?? `YouTube video ${ytId}`;
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO note_videos (id, note_id, youtube_id, title, url, sort_order, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unwatched', ?)`,
    )
    .bind(id, noteId, ytId, title, youtubeWatchUrl(ytId), (info?.max_order ?? -1) + 1, new Date().toISOString())
    .run();
  return c.json({ video: (await getVideo(db, id))! });
});

videos.patch("/videos/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  if (!(await getVideo(db, id))) throw new HttpError(404, "Video not found");
  const body = await readJson(c);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUSES.includes(body.status as VideoStatus)) {
      throw new HttpError(400, "Invalid status");
    }
    sets.push("status = ?");
    params.push(body.status);
  }
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) throw new HttpError(400, "Invalid title");
    sets.push("title = ?");
    params.push(body.title.trim().slice(0, 300));
  }
  if (sets.length) {
    await db
      .prepare(`UPDATE note_videos SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...params, id)
      .run();
  }
  return c.json({ video: (await getVideo(db, id))! });
});

videos.put("/notes/:id/videos/order", async (c) => {
  const db = c.env.DB;
  const noteId = c.req.param("id");
  if (!(await getNoteRow(db, noteId))) throw new HttpError(404, "Note not found");
  const body = await readJson(c);
  if (!Array.isArray(body.ids) || body.ids.some((i) => typeof i !== "string")) {
    throw new HttpError(400, "ids must be an array of strings");
  }
  const ids = body.ids as string[];
  if (new Set(ids).size !== ids.length) throw new HttpError(400, "Duplicate ids");

  const current = await loadVideos(db, noteId);
  const valid = new Set(current.map((v) => v.id));
  if (ids.some((i) => !valid.has(i))) throw new HttpError(400, "ids must belong to this note");
  // listed ids first, in the given order; any omitted ones keep relative order after
  const finalOrder = [...ids, ...current.map((v) => v.id).filter((i) => !ids.includes(i))];
  if (finalOrder.length) {
    await db.batch(
      finalOrder.map((vid, idx) =>
        db.prepare("UPDATE note_videos SET sort_order = ? WHERE id = ? AND note_id = ?").bind(idx, vid, noteId),
      ),
    );
  }
  return c.json({ videos: await loadVideos(db, noteId) });
});

videos.delete("/videos/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM note_videos WHERE id = ?").bind(c.req.param("id")).run();
  if (!res.meta.changes) throw new HttpError(404, "Video not found");
  return c.body(null, 204);
});
