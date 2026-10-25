import { Hono } from "hono";
import { TEMPLATES } from "../../shared/templates";
import type { Note, NoteVideo, UserPrefs } from "../../shared/types";
import { HttpError, type AppEnv } from "../env";
import { readJson } from "../lib/http";
import { NOTE_ORDER, loadTags, toNote, toSummary, type NoteRow } from "../lib/notes-db";
import { toMarkdown } from "../lib/tiptap";
import { endSabrSession, putSabrSession, takeSabrMuxSession } from "../lib/sabrSessions";
import {
  muxSabrTracks,
  peekSabrQualities,
  proxyUpstream,
  resolveAndroidCatalog,
  resolveAndroidStream,
  searchAndroid,
  startSabrStreams,
} from "../lib/ytAndroid";
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

/* ---------- YouTube Innertube search ---------- */

misc.get("/youtube/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) throw new HttpError(400, "Query required");
  try {
    const results = await searchAndroid(q);
    return c.json({ results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "YouTube search failed";
    throw new HttpError(502, msg);
  }
});

/* ---------- embed-blocked media (Android Innertube → proxied MP4) ---------- */

misc.get("/media/youtube/:youtubeId", async (c) => {
  const id = c.req.param("youtubeId");
  checkYtId(id);
  try {
    const catalog = await resolveAndroidCatalog(id);
    const preferred =
      catalog.qualities.find((q) => q.itag === catalog.preferredItag) ?? catalog.qualities[0]!;
    return c.json({
      youtubeId: catalog.youtubeId,
      title: catalog.title,
      duration_seconds: catalog.durationSeconds,
      mimeType: preferred.mimeType,
      itag: preferred.itag,
      label: preferred.label,
      kind: preferred.kind,
      height: preferred.height,
      src:
        preferred.kind === "progressive"
          ? `/api/media/youtube/${id}/stream?itag=${preferred.itag}`
          : null,
      sabr: preferred.kind === "sabr",
      expires_at: catalog.expiresAt,
      qualities: catalog.qualities.map((q) => ({
        itag: q.itag,
        label: q.label,
        height: q.height,
        kind: q.kind,
        codecs: q.codecs ?? null,
        src: q.kind === "progressive" ? `/api/media/youtube/${id}/stream?itag=${q.itag}` : null,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Couldn't resolve a stream";
    throw new HttpError(422, msg);
  }
});

misc.get("/media/youtube/:youtubeId/stream", async (c) => {
  const id = c.req.param("youtubeId");
  checkYtId(id);
  const itagRaw = c.req.query("itag");
  const itag = itagRaw ? Number(itagRaw) : undefined;
  try {
    const stream = await resolveAndroidStream(id, Number.isFinite(itag) ? itag : undefined);
    if (stream.kind !== "progressive" || !stream.upstreamUrl) {
      throw new HttpError(400, "That quality needs SABR playback — pick it in the player.");
    }
    return proxyUpstream(stream.upstreamUrl, c.req.header("Range") ?? null);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = e instanceof Error ? e.message : "Couldn't resolve a stream";
    throw new HttpError(422, msg);
  }
});

/**
 * Reserve a SABR session. Actual googlevideo I/O starts on GET …/mux so all
 * streaming stays inside one Workers request (cross-request streams are forbidden).
 */
misc.post("/media/youtube/:youtubeId/sabr/start", async (c) => {
  const id = c.req.param("youtubeId");
  checkYtId(id);
  const body = await readJson(c).catch(() => ({} as Record<string, unknown>));
  const height = Math.min(1080, Math.max(144, Number(body.height) || 720));
  try {
    const peeked = await peekSabrQualities(id, height);
    const sessionId = putSabrSession({
      youtubeId: id,
      height,
      videoMime: peeked.videoMime,
      audioMime: peeked.audioMime,
      label: peeked.label,
    });
    return c.json({
      sessionId,
      label: peeked.label,
      height,
      muxUrl: `/api/media/youtube/${id}/sabr/${sessionId}/mux`,
      videoMime: peeked.videoMime,
      audioMime: peeked.audioMime,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Couldn't start SABR stream";
    throw new HttpError(422, msg);
  }
});

/** Framed mux: [u8 type][u32be len][bytes] — type 1=video, 2=audio, 0=end. */
misc.get("/media/youtube/:youtubeId/sabr/:sessionId/mux", async (c) => {
  const sessionId = c.req.param("sessionId");
  const meta = takeSabrMuxSession(sessionId);
  if (!meta) throw new HttpError(404, "SABR session expired — pick the quality again.");
  try {
    const started = await startSabrStreams(meta.youtubeId, meta.height);
    const body = muxSabrTracks(started.videoStream, started.audioStream, started.abort);
    return new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Sabr-Video-Mime": started.videoMime,
        "X-Sabr-Audio-Mime": started.audioMime,
        "X-Sabr-Label": started.label,
      },
    });
  } catch (e) {
    endSabrSession(sessionId);
    const msg = e instanceof Error ? e.message : "Couldn't start SABR stream";
    throw new HttpError(422, msg);
  }
});

misc.delete("/media/youtube/:youtubeId/sabr/:sessionId", async (c) => {
  endSabrSession(c.req.param("sessionId"));
  return c.body(null, 204);
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
