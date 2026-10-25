-- Image (and later PDF) attachment metadata; bytes live in R2.
CREATE TABLE note_attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_note_attachments_note ON note_attachments(note_id);
