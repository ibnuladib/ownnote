/** Client-only Pomodoro state (localStorage). Survives reload via endsAt. */

export type PomodoroMode = "work" | "break";

export type PomodoroState = {
  mode: PomodoroMode;
  workMin: number;
  breakMin: number;
  remainingMs: number;
  running: boolean;
  /** Absolute deadline while running; null when paused. */
  endsAt: number | null;
};

export const POMODORO_KEY = "ownnote-pomodoro";
export const DEFAULT_WORK_MIN = 25;
export const DEFAULT_BREAK_MIN = 5;

const MIN_MINUTES = 1;
const MAX_MINUTES = 180;

function clampMin(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n)));
}

export function durationMs(mode: PomodoroMode, workMin: number, breakMin: number): number {
  return (mode === "work" ? workMin : breakMin) * 60_000;
}

export function defaultPomodoro(): PomodoroState {
  return {
    mode: "work",
    workMin: DEFAULT_WORK_MIN,
    breakMin: DEFAULT_BREAK_MIN,
    remainingMs: DEFAULT_WORK_MIN * 60_000,
    running: false,
    endsAt: null,
  };
}

function normalize(raw: unknown): PomodoroState {
  const d = defaultPomodoro();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Record<string, unknown>;
  const mode: PomodoroMode = o.mode === "break" ? "break" : "work";
  const workMin = clampMin(Number(o.workMin), DEFAULT_WORK_MIN);
  const breakMin = clampMin(Number(o.breakMin), DEFAULT_BREAK_MIN);
  const running = o.running === true;
  const endsAt =
    running && typeof o.endsAt === "number" && Number.isFinite(o.endsAt) ? o.endsAt : null;
  let remainingMs =
    typeof o.remainingMs === "number" && Number.isFinite(o.remainingMs)
      ? Math.max(0, o.remainingMs)
      : durationMs(mode, workMin, breakMin);
  if (running && endsAt != null) {
    remainingMs = Math.max(0, endsAt - Date.now());
  }
  return { mode, workMin, breakMin, remainingMs, running: running && endsAt != null, endsAt };
}

export function loadPomodoro(): PomodoroState {
  try {
    const raw = localStorage.getItem(POMODORO_KEY);
    if (!raw) return defaultPomodoro();
    return tickPomodoro(normalize(JSON.parse(raw)));
  } catch {
    return defaultPomodoro();
  }
}

export function savePomodoro(state: PomodoroState): void {
  try {
    localStorage.setItem(POMODORO_KEY, JSON.stringify(state));
  } catch {
    /* storage blocked */
  }
}

/** Recompute remaining from endsAt; auto-switch work↔break when the timer hits 0. */
export function tickPomodoro(state: PomodoroState, now = Date.now()): PomodoroState {
  if (!state.running || state.endsAt == null) return state;

  const remaining = state.endsAt - now;
  if (remaining > 0) {
    if (remaining === state.remainingMs) return state;
    return { ...state, remainingMs: remaining };
  }

  // Expired — flip mode and keep running into the next phase.
  const mode: PomodoroMode = state.mode === "work" ? "break" : "work";
  const remainingMs = durationMs(mode, state.workMin, state.breakMin);
  return {
    ...state,
    mode,
    remainingMs,
    running: true,
    endsAt: now + remainingMs,
  };
}

export function startPomodoro(state: PomodoroState, now = Date.now()): PomodoroState {
  if (state.running) return state;
  const remainingMs =
    state.remainingMs > 0
      ? state.remainingMs
      : durationMs(state.mode, state.workMin, state.breakMin);
  return { ...state, running: true, remainingMs, endsAt: now + remainingMs };
}

export function pausePomodoro(state: PomodoroState, now = Date.now()): PomodoroState {
  if (!state.running) return state;
  const remainingMs =
    state.endsAt != null ? Math.max(0, state.endsAt - now) : state.remainingMs;
  return { ...state, running: false, remainingMs, endsAt: null };
}

export function resetPomodoro(state: PomodoroState): PomodoroState {
  return {
    ...state,
    running: false,
    endsAt: null,
    remainingMs: durationMs(state.mode, state.workMin, state.breakMin),
  };
}

export function setWorkMin(state: PomodoroState, workMin: number): PomodoroState {
  const next = clampMin(workMin, state.workMin);
  const base = state.running ? pausePomodoro(state) : state;
  const remainingMs =
    base.mode === "work" ? next * 60_000 : base.remainingMs;
  return { ...base, workMin: next, remainingMs, running: false, endsAt: null };
}

export function setBreakMin(state: PomodoroState, breakMin: number): PomodoroState {
  const next = clampMin(breakMin, state.breakMin);
  const base = state.running ? pausePomodoro(state) : state;
  const remainingMs =
    base.mode === "break" ? next * 60_000 : base.remainingMs;
  return { ...base, breakMin: next, remainingMs, running: false, endsAt: null };
}

/** Format remaining as mm:ss (ceil so the last second still shows 00:01). */
export function formatRemaining(ms: number): string {
  const total = ms > 0 ? Math.ceil(ms / 1000) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
