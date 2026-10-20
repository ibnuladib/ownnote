import { useSyncExternalStore } from "react";

/** "system" follows the OS; "light"/"dark" are manual overrides. */
export type ThemePref = "system" | "light" | "dark";

const KEY = "ownnote-theme";
const THEME_COLOR = { light: "#f1f3f6", dark: "#282a36" } as const;

const listeners = new Set<() => void>();
const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* storage blocked: fall back to system */
  }
  return "system";
}

let pref: ThemePref = read();

function apply() {
  const theme = pref === "system" ? (media?.matches ? "dark" : "light") : pref;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

function emit() {
  apply();
  listeners.forEach((l) => l());
}

/** Call once at startup (index.html already set data-theme pre-paint). */
export function initTheme() {
  apply();
  media?.addEventListener("change", () => pref === "system" && emit());
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    pref = read();
    emit();
  });
}

export function setThemePref(next: ThemePref) {
  pref = next;
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* non-persistent, still applies this session */
  }
  emit();
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => pref,
  );
}
