import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft, Search, Star, Terminal } from "lucide-react";
import type { NoteSummary } from "@shared/types";
import { api } from "../api";
import { relativeTime } from "../lib/time";

export type PaletteCommand = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

type Props = {
  recent: NoteSummary[];
  commands?: PaletteCommand[];
  onPick: (id: string) => void;
  onClose: () => void;
};

export function SearchPalette({ recent, commands = [], onPick, onClose }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<NoteSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [idx, setIdx] = useState(0);
  const seq = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  const isCommandMode = q.trimStart().startsWith(">");
  const cmdQuery = isCommandMode ? q.trimStart().slice(1).trim().toLowerCase() : "";

  const matchedCommands = useMemo(() => {
    if (!isCommandMode) return [];
    if (!cmdQuery) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(cmdQuery) ||
        (c.hint && c.hint.toLowerCase().includes(cmdQuery)),
    );
  }, [cmdQuery, commands, isCommandMode]);

  useEffect(() => {
    if (isCommandMode) {
      setResults(null);
      setFailed(false);
      return;
    }
    const term = q.trim();
    if (!term) {
      setResults(null);
      setFailed(false);
      return;
    }
    setResults(null);
    setFailed(false);
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api
        .search(term)
        .then((r) => {
          if (mine !== seq.current) return;
          setResults(r);
          setFailed(false);
          setIdx(0);
        })
        .catch(() => {
          if (mine === seq.current) setFailed(true);
        });
    }, 180);
    return () => clearTimeout(t);
  }, [q, isCommandMode]);

  // While a query is in flight, don't fall back to "recent" (that made search look like 8 hits).
  const querying = !isCommandMode && !!q.trim();
  const shown = querying ? (results ?? []) : recent.slice(0, 8);
  const activeLength = isCommandMode ? matchedCommands.length : shown.length;

  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: "nearest" });
  }, [idx, shown, matchedCommands]);

  function key(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(Math.max(0, activeLength - 1), i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      if (isCommandMode && matchedCommands[idx]) {
        e.preventDefault();
        const cmd = matchedCommands[idx]!;
        onClose();
        cmd.run();
      } else if (!isCommandMode && shown[idx]) {
        e.preventDefault();
        onPick(shown[idx].id);
      }
    }
  }

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search notes"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input">
          {isCommandMode ? <Terminal size={18} /> : <Search size={18} />}
          <input
            autoFocus
            placeholder="Search titles and contents… (or type > for commands)"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={key}
            aria-label="Search"
          />
          {commands.length > 0 && (
            <button
              type="button"
              className={`palette-mode-pill ${isCommandMode ? "is-on" : ""}`}
              onClick={() => {
                setQ((prev) => (prev.trimStart().startsWith(">") ? "" : "> "));
                setIdx(0);
              }}
              title="Toggle command mode (>)"
            >
              {isCommandMode ? "Notes" : "> Cmd"}
            </button>
          )}
          <kbd>Esc</kbd>
        </div>

        {isCommandMode ? (
          <>
            <p className="palette-label">{matchedCommands.length} commands</p>
            <ul ref={listRef} role="listbox">
              {matchedCommands.length === 0 && (
                <li className="palette-empty">No matching commands.</li>
              )}
              {matchedCommands.map((cmd, i) => (
                <li key={cmd.id} role="option" aria-selected={i === idx} data-sel={i === idx}>
                  <button
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => {
                      onClose();
                      cmd.run();
                    }}
                  >
                    <span className="pal-title">
                      <Terminal size={13} />
                      {cmd.label}
                    </span>
                    {cmd.hint && <kbd>{cmd.hint}</kbd>}
                    {i === idx && <CornerDownLeft size={14} />}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="palette-label">
              {querying ? (results ? `${results.length} found` : "Searching…") : "Recent"}
            </p>
            <ul ref={listRef} role="listbox">
              {failed && <li className="palette-empty">Search failed. Try again.</li>}
              {!failed && querying && results === null && (
                <li className="palette-empty">Searching…</li>
              )}
              {!failed && !(querying && results === null) && shown.length === 0 && (
                <li className="palette-empty">No matching notes.</li>
              )}
              {shown.map((n, i) => (
                <li key={n.id} role="option" aria-selected={i === idx} data-sel={i === idx}>
                  <button onMouseEnter={() => setIdx(i)} onClick={() => onPick(n.id)}>
                    <span className="pal-title">
                      {n.pinned && <Star size={12} fill="currentColor" />}
                      {n.title.trim() || "Untitled"}
                    </span>
                    <span className="pal-meta">
                      {n.tags.map((t) => `#${t}`).join(" ")} {relativeTime(n.updated_at)}
                    </span>
                    {i === idx && <CornerDownLeft size={14} />}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
