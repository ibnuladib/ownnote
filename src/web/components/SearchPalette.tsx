import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft, Search, Star } from "lucide-react";
import type { NoteSummary } from "@shared/types";
import { api } from "../api";
import { relativeTime } from "../lib/time";

type Props = {
  recent: NoteSummary[];
  onPick: (id: string) => void;
  onClose: () => void;
};

export function SearchPalette({ recent, onPick, onClose }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<NoteSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [idx, setIdx] = useState(0);
  const seq = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults(null);
      setFailed(false);
      return;
    }
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
        .catch(() => mine === seq.current && setFailed(true));
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const shown = results ?? recent.slice(0, 8);

  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: "nearest" });
  }, [idx, shown]);

  function key(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && shown[idx]) {
      e.preventDefault();
      onPick(shown[idx].id);
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
          <Search size={18} />
          <input
            autoFocus
            placeholder="Search titles and contents…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={key}
            aria-label="Search"
          />
          <kbd>Esc</kbd>
        </div>
        <p className="palette-label">{results ? `${results.length} found` : "Recent"}</p>
        <ul ref={listRef} role="listbox">
          {failed && <li className="palette-empty">Search failed. Try again.</li>}
          {!failed && shown.length === 0 && <li className="palette-empty">No matching notes.</li>}
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
      </div>
    </div>
  );
}
