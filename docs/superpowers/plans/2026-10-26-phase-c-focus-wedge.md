# Phase C Focus Wedge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Pomodoro, image paste via R2, YouTube timestamp chips with soft seek, and in-app YouTube search.

**Architecture:** R2 for binaries; TipTap JSON for timestamp chips; Worker Innertube search; soft seek API on YouTubePlayer; Pomodoro in topbar with localStorage.

**Tech Stack:** React 19, TipTap 2, Hono, Cloudflare Workers/D1/R2, existing ytAndroid Innertube client.

**Spec:** `docs/superpowers/specs/2026-10-26-phase-c-a-learning-workspace-design.md`

## Global Constraints

- Do not commit `.dev.vars` or secrets.
- Commit after each task completes successfully.
- Match existing patterns in `api.ts`, `HttpError`, auth middleware, CSS theme tokens.
- Keep Phase A (PDF) out of this plan’s code changes.

## Review Focus

- Oversized image upload should 413, not hang or bloat D1.
- Timestamp click must soft-seek even in SABR/direct mode without losing buffer needlessly.
- Search endpoint must require auth and tolerate Innertube shape drift (empty results, not 500 HTML).
- Attachment GET must not serve another note’s file if id is guessed (join note ownership via row).
- Pomodoro must not steal focus from TipTap typing (no aggressive global key capture).

---

### Task 1: R2 binding + attachments schema + upload/serve API

**Files:**
- Modify: `wrangler.toml`, `src/worker/env.ts`, `src/worker/index.ts`
- Create: `migrations/0002_attachments.sql`, `src/worker/routes/attachments.ts`
- Modify: `docs/CONTRACT.md` (attachments section)

- [ ] Add `[[r2_buckets]]` binding `ATTACHMENTS` / `ownnote-attachments`
- [ ] Extend `Env` with `ATTACHMENTS: R2Bucket`
- [ ] Migration `note_attachments` table with FK cascade on notes
- [ ] Routes: POST multipart upload, GET stream, DELETE optional; max 5MB; image/* only
- [ ] Apply local migration; smoke with curl/fetch
- [ ] Commit: `feat: add R2 attachments API for note images`

### Task 2: TipTap image paste/drop

**Files:**
- Modify: `package.json` (add `@tiptap/extension-image`), `NoteEditor.tsx`, `api.ts`, `styles.css`

- [ ] `npm install @tiptap/extension-image`
- [ ] `api.uploadAttachment(noteId, file)` via FormData
- [ ] Register Image extension; handlePaste/handleDrop → upload → setImage
- [ ] `.prose img { max-width: 100%; height: auto; }`
- [ ] Manual: paste PNG into note, reload, image loads
- [ ] Commit: `feat: paste images into notes via R2`

### Task 3: Pomodoro topbar

**Files:**
- Create: `src/web/lib/pomodoro.ts`, `src/web/components/Pomodoro.tsx`
- Modify: `Workspace.tsx`, `styles.css`

- [ ] localStorage state: mode, remaining, running, durations
- [ ] Compact UI in topbar; start/pause/reset; work↔break
- [ ] No form-stealing hotkeys beyond optional space when focused on control
- [ ] Commit: `feat: add Pomodoro timer to workspace topbar`

### Task 4: Soft seekTo + current time bridge

**Files:**
- Modify: `YouTubePlayer.tsx`, `VideoPanel.tsx`, `Workspace.tsx`

- [ ] Expose `seekTo(seconds)` and `getCurrentTime()` (ref or callbacks) for iframe + direct
- [ ] VideoPanel forwards active `youtubeId`, getTime, seekTo to Workspace
- [ ] Commit: `feat: expose soft seek API on YouTube player`

### Task 5: Timestamp chips in TipTap

**Files:**
- Create: `src/web/components/timestampChip.ts` (or `extensions/timestampChip.ts`)
- Modify: `NoteEditor.tsx`, `Workspace.tsx`, `styles.css`

- [ ] Inline atom node with youtubeId + seconds; clickable chip UI
- [ ] Toolbar insert using Workspace-provided getCurrentTime + youtubeId
- [ ] Click chip → Workspace seekTo (and ensure that video is active if needed)
- [ ] Commit: `feat: link notes to YouTube timestamps`

### Task 6: YouTube Innertube search

**Files:**
- Modify: `src/worker/lib/ytAndroid.ts`, `src/worker/routes/misc.ts` (or videos), `api.ts`, `VideoPanel.tsx`, `styles.css`, `docs/CONTRACT.md`
- Create: `src/web/components/YoutubeSearchModal.tsx`

- [ ] `searchAndroid(q)` → normalized results
- [ ] `GET /api/youtube/search?q=`
- [ ] Modal + Search button beside add-URL form; pick → `addVideo`
- [ ] Commit: `feat: search YouTube and add videos in-app`

### Task 7: Local verify + polish CONTRACT if needed

- [ ] Ensure `npm run worker:dev` and `npm run dev` work with R2 + D1
- [ ] Quick smoke of C1–C6 flows
- [ ] Commit any doc/test fixes: `chore: document Phase C APIs`
