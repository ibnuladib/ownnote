-- Large images that used to live in R2 (over D1's ~1MB row limit) are stored as chunks.

CREATE TABLE IF NOT EXISTS note_attachment_chunks (
  attachment_id TEXT NOT NULL REFERENCES note_attachments(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  data          BLOB NOT NULL,
  PRIMARY KEY (attachment_id, chunk_index)
);
