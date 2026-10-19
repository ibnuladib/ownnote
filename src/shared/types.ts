/** Shared types — keep aligned with docs/CONTRACT.md */

export type TipTapJSON = Record<string, unknown>;

export type VideoStatus = "unwatched" | "in_progress" | "done";

export type NoteSummary = {
  id: string;
  title: string;
  pinned: boolean;
  pinned_at: string | null;
  last_opened_at: string | null;
  updated_at: string;
  tags: string[];
};

export type Note = NoteSummary & {
  content: TipTapJSON;
  template_key: string | null;
  created_at: string;
};

export type NoteVideo = {
  id: string;
  note_id: string;
  youtube_id: string;
  title: string;
  url: string;
  sort_order: number;
  status: VideoStatus;
  created_at: string;
  position_seconds?: number;
  duration_seconds?: number | null;
};

export type UserPrefs = {
  last_note_id: string | null;
  last_video_id: string | null;
};

export type TemplateMeta = {
  key: string;
  name: string;
  description: string;
};
