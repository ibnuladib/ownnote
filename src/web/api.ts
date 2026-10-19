import type {
  Note,
  NoteSummary,
  NoteVideo,
  TemplateMeta,
  TipTapJSON,
  UserPrefs,
  VideoStatus,
} from "@shared/types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  keepalive = false,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    keepalive,
  });
  if (res.status === 401 && path !== "/api/login") unauthorizedHandler?.();
  if (!res.ok) {
    let msg = res.statusText || `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type NotePatch = { title?: string; content?: TipTapJSON; pinned?: boolean };
export type WatchState = { position_seconds: number; duration_seconds: number | null };

export const api = {
  // auth
  login: (password: string) => req<void>("POST", "/api/login", { password }),
  logout: () => req<void>("POST", "/api/logout"),
  me: () => req<{ ok: true }>("GET", "/api/me"),

  // notes
  listNotes: (tag?: string | null) =>
    req<{ notes: NoteSummary[] }>(
      "GET",
      tag ? `/api/notes?tag=${encodeURIComponent(tag)}` : "/api/notes",
    ).then((r) => r.notes),
  getNote: (id: string) => req<{ note: Note }>("GET", `/api/notes/${id}`).then((r) => r.note),
  createNote: (title?: string, content?: TipTapJSON) =>
    req<{ note: Note }>("POST", "/api/notes", { title, content }).then((r) => r.note),
  createFromTemplate: (key: string, title?: string) =>
    req<{ note: Note }>("POST", "/api/notes/from-template", { key, title }).then((r) => r.note),
  patchNote: (id: string, patch: NotePatch, keepalive = false) =>
    req<{ note: Note }>("PATCH", `/api/notes/${id}`, patch, keepalive).then((r) => r.note),
  deleteNote: (id: string) => req<void>("DELETE", `/api/notes/${id}`),

  // tags
  listTags: () =>
    req<{ tags: { id: string; name: string }[] }>("GET", "/api/tags").then((r) => r.tags),
  setTags: (id: string, tags: string[]) =>
    req<{ tags: string[] }>("PUT", `/api/notes/${id}/tags`, { tags }).then((r) => r.tags),

  // search / templates
  search: (q: string, tag?: string | null) =>
    req<{ notes: NoteSummary[] }>(
      "GET",
      `/api/search?q=${encodeURIComponent(q)}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`,
    ).then((r) => r.notes),
  templates: () =>
    req<{ templates: TemplateMeta[] }>("GET", "/api/templates").then((r) => r.templates),

  // prefs
  getPrefs: () => req<UserPrefs>("GET", "/api/prefs"),
  putPrefs: (p: Partial<UserPrefs>) => req<UserPrefs>("PUT", "/api/prefs", p),

  // videos
  listVideos: (noteId: string) =>
    req<{ videos: NoteVideo[] }>("GET", `/api/notes/${noteId}/videos`).then((r) => r.videos),
  addVideo: (noteId: string, url: string) =>
    req<{ video: NoteVideo }>("POST", `/api/notes/${noteId}/videos`, { url }).then((r) => r.video),
  patchVideo: (id: string, patch: { status?: VideoStatus; title?: string }) =>
    req<{ video: NoteVideo }>("PATCH", `/api/videos/${id}`, patch).then((r) => r.video),
  reorderVideos: (noteId: string, ids: string[]) =>
    req<{ videos: NoteVideo[] }>("PUT", `/api/notes/${noteId}/videos/order`, { ids }).then(
      (r) => r.videos,
    ),
  deleteVideo: (id: string) => req<void>("DELETE", `/api/videos/${id}`),

  // watch progress (keyed by YouTube id)
  getWatch: (youtubeId: string) => req<WatchState>("GET", `/api/watch/${youtubeId}`),
  putWatch: (
    youtubeId: string,
    body: { position_seconds: number; duration_seconds?: number },
    keepalive = false,
  ) => req<WatchState>("PUT", `/api/watch/${youtubeId}`, body, keepalive),
};

export const exportUrl = (format: "json" | "markdown") => `/api/export?format=${format}`;
