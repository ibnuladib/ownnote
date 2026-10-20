/**
 * SABR session metadata only. Media bytes are streamed from a single /mux
 * request (Workers cannot share I/O streams across requests).
 */

type Entry = {
  youtubeId: string;
  height: number;
  videoMime: string;
  audioMime: string;
  label: string;
  createdAt: number;
  muxTaken: boolean;
};

const sessions = new Map<string, Entry>();
const TTL_MS = 2 * 60 * 60 * 1000;

function gc() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > TTL_MS) sessions.delete(id);
  }
}

export function putSabrSession(entry: Omit<Entry, "createdAt" | "muxTaken">): string {
  gc();
  const id = crypto.randomUUID();
  sessions.set(id, { ...entry, muxTaken: false, createdAt: Date.now() });
  return id;
}

export function takeSabrMuxSession(id: string): Entry | null {
  gc();
  const s = sessions.get(id);
  if (!s || s.muxTaken) return null;
  s.muxTaken = true;
  return s;
}

export function endSabrSession(id: string) {
  sessions.delete(id);
}
