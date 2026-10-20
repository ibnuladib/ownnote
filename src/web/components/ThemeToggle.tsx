import { Monitor, Moon, Sun } from "lucide-react";
import { setThemePref, useThemePref, type ThemePref } from "../lib/theme";

const ORDER: ThemePref[] = ["system", "light", "dark"];
const LABEL: Record<ThemePref, string> = { system: "System", light: "Light", dark: "Dark" };
const ICON = { system: Monitor, light: Sun, dark: Moon };

/** One button, cycles System → Light → Dark. The icon shows the current preference. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const pref = useThemePref();
  const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]!;
  const Icon = ICON[pref];
  return (
    <button
      type="button"
      className={`theme-toggle ${className}`.trim()}
      onClick={() => setThemePref(next)}
      aria-label={`Theme: ${LABEL[pref]}. Switch to ${LABEL[next]}`}
      title={`Theme: ${LABEL[pref]} (click for ${LABEL[next]})`}
    >
      <Icon size={16} />
    </button>
  );
}
