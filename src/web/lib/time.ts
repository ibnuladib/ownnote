/** Parse API timestamps; SQLite-style "YYYY-MM-DD HH:MM:SS" is treated as UTC. */
export function parseDate(s: string | null | undefined): number {
  if (!s) return 0;
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(s);
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const t = Date.parse(hasZone ? iso : `${iso}Z`);
  return Number.isNaN(t) ? 0 : t;
}

export function relativeTime(s: string | null | undefined): string {
  const t = parseDate(s);
  if (!t) return "";
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}
