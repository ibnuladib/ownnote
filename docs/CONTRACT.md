# OwnNote API Contract (v1)

Shared contract for frontend / backend / QA. Keep this in sync when changing endpoints.

Base URL: same origin. All `/api/*` except `POST /api/login` require session cookie `ownnote_session`.

## Auth

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/login` | `{ "password": string }` | `204` + Set-Cookie; `401` invalid; `429` rate limit |
| POST | `/api/logout` | — | `204` |
| GET | `/api/me` | — | `{ "ok": true }` or `401` |

Cookie: `ownnote_session=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=/`

## Notes

| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET | `/api/notes` | `?tag=` optional | `{ "notes": NoteSummary[] }` |
| POST | `/api/notes` | `{ "title"?: string, "content"?: TipTapJSON }` | `{ "note": Note }` |
| GET | `/api/notes/:id` | — | `{ "note": Note }` |
| PATCH | `/api/notes/:id` | partial `{ title, content, pinned }` | `{ "note": Note }` |
| DELETE | `/api/notes/:id` | — | `204` |
| POST | `/api/notes/from-template` | `{ "key": "learning_journey", "title"?: string }` | `{ "note": Note }` |

## Tags

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/tags` | — | `{ "tags": { "id": string, "name": string }[] }` |
| PUT | `/api/notes/:id/tags` | `{ "tags": string[] }` | `{ "tags": string[] }` |

## Search

| Method | Path | Query | Response |
|--------|------|-------|----------|
| GET | `/api/search` | `q`, optional `tag` | `{ "notes": NoteSummary[] }` |

## Templates

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/templates` | `{ "templates": { "key": string, "name": string, "description": string }[] }` |

## Prefs

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/prefs` | — | `{ "last_note_id": string \| null, "last_video_id": string \| null }` |
| PUT | `/api/prefs` | `{ "last_note_id"?, "last_video_id"? }` | same as GET |

## Videos

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/notes/:id/videos` | — | `{ "videos": NoteVideo[] }` |
| POST | `/api/notes/:id/videos` | `{ "url": string }` | `{ "video": NoteVideo }` |
| PATCH | `/api/videos/:id` | `{ "status"?, "title"? }` | `{ "video": NoteVideo }` |
| PUT | `/api/notes/:id/videos/order` | `{ "ids": string[] }` | `{ "videos": NoteVideo[] }` |
| DELETE | `/api/videos/:id` | — | `204` |

`status`: `"unwatched" | "in_progress" | "done"`

## YouTube search

| Method | Path | Query | Response |
|--------|------|-------|----------|
| GET | `/api/youtube/search` | `q` (required) | `{ "results": [{ "youtubeId", "title", "channel"?, "thumb"? }] }` |

Empty `q` → `400`. Innertube fetch failure → `502`. Soft parse / no hits → `{ "results": [] }` with `200`.

## Attachments (images)

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/api/notes/:id/attachments` | multipart `file` (JPEG/PNG/GIF/WebP, ≤900KB; stored in D1) | `{ "id", "url", "content_type", "byte_size" }` |
| GET | `/api/attachments/:id` | — | binary stream |
| DELETE | `/api/attachments/:id` | — | `204` |

## Watch progress

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/watch/:youtubeId` | — | `{ "position_seconds": number, "duration_seconds": number \| null }` |
| PUT | `/api/watch/:youtubeId` | `{ "position_seconds": number, "duration_seconds"?: number }` | same |

## Export

| Method | Path | Query | Response |
|--------|------|-------|----------|
| GET | `/api/export` | `format=json\|markdown` | file download |

## Types

```ts
type TipTapJSON = Record<string, unknown>; // TipTap doc JSON

type NoteSummary = {
  id: string;
  title: string;
  pinned: boolean;
  pinned_at: string | null;
  last_opened_at: string | null;
  updated_at: string;
  tags: string[];
};

type Note = NoteSummary & {
  content: TipTapJSON;
  template_key: string | null;
  created_at: string;
};

type NoteVideo = {
  id: string;
  note_id: string;
  youtube_id: string;
  title: string;
  url: string;
  sort_order: number;
  status: "unwatched" | "in_progress" | "done";
  created_at: string;
  position_seconds?: number;
  duration_seconds?: number | null;
};
```

## Errors

JSON `{ "error": string }` with 4xx/5xx. Never include password or session tokens in responses/logs.

## File ownership

| Owner | Paths |
|-------|--------|
| Backend | `src/worker/**`, `migrations/**`, `wrangler.toml`, `scripts/**` |
| Frontend | `src/web/**` |
| Shared | `src/shared/**`, `docs/CONTRACT.md`, root `package.json` (coordinate deps) |
| QA | `tests/**`, `playwright.config.*` |
