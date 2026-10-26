-- Bytes in D1 instead of R2 (D1 max row ~1MB; app caps uploads under that).
ALTER TABLE note_attachments ADD COLUMN data BLOB;
