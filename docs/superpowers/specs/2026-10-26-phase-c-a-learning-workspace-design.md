# OwnNote Phase C → A — Learning Workspace Design

**Status:** Approved  
**Date:** 2026-10-26

## Intent

Grow OwnNote from notes + YouTube into a personal all-in-one learning workspace. Ship a **focus wedge (Phase C)** first, then **PDF sources (Phase A)**. Deferred: AI agent, web/article clipper, in-app password change, folders, sharing, PWA.

## Constraints

- Single shared-password vault on Cloudflare Workers + D1 (unchanged auth).
- Prefer client-side media viewers; Worker proxies bytes and YouTube Innertube only.
- No base64 blobs in D1. Binary assets live in R2.
- Commit frequently during implementation.
- YAGNI: no polymorphic `sources` table until a third source type needs it.

## Phase C — Focus wedge

### C1. Image paste / drop

- Add R2 binding `ATTACHMENTS` (`ownnote-attachments`).
- Table `note_attachments(id, note_id, r2_key, content_type, byte_size, created_at)`.
- `POST /api/notes/:id/attachments` (multipart, image MIME only, ~5MB cap).
- `GET /api/attachments/:id` streams from R2 (session auth).
- TipTap `@tiptap/extension-image`; paste/drop uploads then inserts `src=/api/attachments/:id`.
- Reject `data:` URLs in persisted content when practical.

### C2. Pomodoro

- Compact control in **topbar** (not VideoPanel / editor toolbar).
- Client-only `localStorage`; work/break lengths; start/pause/reset.
- Match existing `top-btn` / theme tokens.

### C3. YouTube timestamp ↔ note

- TipTap inline atom node `timestampChip` attrs: `{ youtubeId, seconds, label? }`.
- Toolbar button (+ optional hotkey) inserts current player time for active video.
- Soft `seekTo(seconds)` on `YouTubePlayer` (iframe + direct/SABR) — not full reload via `PlayRequest`.
- Workspace bridges getCurrentTime / seek / youtubeId between VideoPanel and NoteEditor.
- Anchors live in TipTap JSON only (no `note_anchors` table).

### C4. In-app YouTube search

- Worker: Innertube ANDROID `youtubei/v1/search` via existing `ytAndroid` client context.
- `GET /api/youtube/search?q=` → `{ results: [{ youtubeId, title, channel?, thumb? }] }`.
- UI modal from VideoPanel; pick → existing `POST .../videos` / `addVideo`.
- Auth-gated; debounce; no Data API key.

## Phase A — PDF sources (after C)

- Keep `note_videos`; add `note_pdfs` + R2 objects (reuse `ATTACHMENTS` bucket, `pdfs/` prefix).
- Right pane: Video | PDF mode toggle (same `pane-watch` slot; no 4th column).
- `pdfjs-dist` in SPA; Worker only stores/serves bytes.
- Highlights: page + quads → TipTap `pdfAnchor` chip; click → open PDF + navigate/overlay.
- Out: OCR, polymorphic sources schema, Worker PDF parse, dual Video+PDF columns.

## Non-goals (this effort)

AI agent, article/web snapshots, password change UI, note version history, multi-user.

## Success criteria

1. Local `wrangler dev` + Vite: paste image into a note and reload — image still loads.
2. Pomodoro runs across pane switches; state survives reload.
3. Insert timestamp while a video plays; click chip seeks without remounting the player.
4. Search YouTube in-app and add a result to the queue.
5. (Phase A later) Upload PDF, highlight, chip jump-back.
