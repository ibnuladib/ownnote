-- Phase A: PDF sources (chunked in D1 so multi-MB papers fit under D1's 1MB row limit) + query indexes.

CREATE TABLE IF NOT EXISTS note_pdfs (
  id           TEXT PRIMARY KEY,
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  page_count   INTEGER NOT NULL DEFAULT 1,
  current_page INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'reading', 'done')),
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_pdfs_note ON note_pdfs(note_id, created_at);

CREATE TABLE IF NOT EXISTS note_pdf_chunks (
  pdf_id      TEXT NOT NULL REFERENCES note_pdfs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  data        BLOB NOT NULL,
  PRIMARY KEY (pdf_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_note ON note_tags(note_id);
