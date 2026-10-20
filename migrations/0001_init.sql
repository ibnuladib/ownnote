-- OwnNote initial schema (Cloudflare D1 / SQLite)

CREATE TABLE notes (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT 'Untitled',
  content        TEXT NOT NULL DEFAULT '{"type":"doc","content":[{"type":"paragraph"}]}', -- TipTap JSON as text
  search_text    TEXT NOT NULL DEFAULT '',   -- plain text extracted from content (LIKE fallback + FTS body)
  template_key   TEXT,
  pinned         INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  pinned_at      TEXT,
  last_opened_at TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_notes_order ON notes (pinned DESC, pinned_at DESC, updated_at DESC);

CREATE TABLE tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);
CREATE INDEX idx_note_tags_tag ON note_tags (tag_id);

CREATE TABLE note_videos (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  youtube_id TEXT NOT NULL,
  title      TEXT NOT NULL,
  url        TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'unwatched' CHECK (status IN ('unwatched', 'in_progress', 'done')),
  created_at TEXT NOT NULL,
  UNIQUE (note_id, youtube_id)
);
CREATE INDEX idx_note_videos_note ON note_videos (note_id, sort_order);

CREATE TABLE watch_progress (
  youtube_id       TEXT PRIMARY KEY,
  position_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL,
  updated_at       TEXT NOT NULL
);

-- Single-user app: exactly one row (id = 1)
CREATE TABLE user_prefs (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  last_note_id  TEXT REFERENCES notes (id) ON DELETE SET NULL,
  last_video_id TEXT REFERENCES note_videos (id) ON DELETE SET NULL
);
INSERT INTO user_prefs (id) VALUES (1);

-- id = SHA-256 hex of the session token (raw token only ever lives in the cookie)
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL  -- unix ms
);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- Login throttling (failed attempts per IP)
CREATE TABLE login_attempts (
  ip           TEXT NOT NULL,
  attempted_at INTEGER NOT NULL  -- unix ms
);
CREATE INDEX idx_login_attempts_ip ON login_attempts (ip, attempted_at);

-- Full-text search (maintained by the Worker; body = notes.search_text)
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title,
  body,
  note_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
