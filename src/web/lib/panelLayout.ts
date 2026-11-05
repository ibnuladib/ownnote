const NOTES_W = "ownnote-notes-w";
const WATCH_W = "ownnote-watch-w";
const NOTES_OPEN = "ownnote-notes-open";
const WATCH_OPEN = "ownnote-watch-open";
const PDF_H = "ownnote-pdf-h";

export const NOTES_DEFAULT = 276;
export const WATCH_DEFAULT = 392;
export const NOTES_MIN = 200;
/** Dragging left of this snaps the notes pane closed (avoids letter-stack crush). */
export const NOTES_SNAP_CLOSE = 140;
export const NOTES_MAX = 480;
export const WATCH_MIN = 260;
/** Absolute ceiling; live drag also leaves room for the editor. */
export const WATCH_MAX = 1600;
export const EDITOR_MIN = 280;
export const PDF_H_MIN = 180;
export const PDF_H_MAX = 2000;

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

export function loadPdfH(): number | null {
  try {
    const raw = localStorage.getItem(PDF_H);
    if (raw === null || raw === "") return null;
    const v = Number(raw);
    if (!Number.isFinite(v)) return null;
    return Math.min(PDF_H_MAX, Math.max(PDF_H_MIN, Math.round(v)));
  } catch {
    return null;
  }
}

export function savePdfH(h: number | null) {
  try {
    if (h === null) localStorage.removeItem(PDF_H);
    else localStorage.setItem(PDF_H, String(Math.round(h)));
  } catch {
    /* ignore */
  }
}

/** Study pane width so the PDF column covers half the window, leaving the editor readable. */
export function halfPageWatchWidth(notesOpen: boolean, notesW: number): number {
  const notesSpace = notesOpen ? notesW + 5 : 0;
  const available = Math.max(0, window.innerWidth - notesSpace - 5);
  const half = Math.round(window.innerWidth / 2);
  const cap = Math.max(WATCH_MIN, available - EDITOR_MIN);
  return Math.min(WATCH_MAX, cap, Math.max(WATCH_MIN, half));
}
