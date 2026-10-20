const NOTES_W = "ownnote-notes-w";
const WATCH_W = "ownnote-watch-w";
const NOTES_OPEN = "ownnote-notes-open";
const WATCH_OPEN = "ownnote-watch-open";

export const NOTES_DEFAULT = 276;
export const WATCH_DEFAULT = 392;
export const NOTES_MIN = 180;
export const NOTES_MAX = 480;
export const WATCH_MIN = 260;
/** Absolute ceiling; live drag also leaves room for the editor. */
export const WATCH_MAX = 1100;
export const EDITOR_MIN = 280;

function readNum(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.round(v)));
  } catch {
    return fallback;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "1" || v === "true";
  } catch {
    return fallback;
  }
}

export function loadPanelLayout() {
  return {
    notesW: readNum(NOTES_W, NOTES_DEFAULT, NOTES_MIN, NOTES_MAX),
    watchW: readNum(WATCH_W, WATCH_DEFAULT, WATCH_MIN, WATCH_MAX),
    notesOpen: readBool(NOTES_OPEN, true),
    watchOpen: readBool(WATCH_OPEN, true),
  };
}

export function saveNotesW(w: number) {
  try {
    localStorage.setItem(NOTES_W, String(w));
  } catch {
    /* ignore */
  }
}

export function saveWatchW(w: number) {
  try {
    localStorage.setItem(WATCH_W, String(w));
  } catch {
    /* ignore */
  }
}

export function saveNotesOpen(open: boolean) {
  try {
    localStorage.setItem(NOTES_OPEN, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function saveWatchOpen(open: boolean) {
  try {
    localStorage.setItem(WATCH_OPEN, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}
