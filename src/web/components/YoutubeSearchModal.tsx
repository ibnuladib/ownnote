import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { api } from "../api";

export type YtSearchResult = {
  youtubeId: string;
  title: string;
  channel?: string;
  thumb?: string;
};

type Props = {
  onPick: (hit: YtSearchResult) => void;
  onClose: () => void;
};

export function YoutubeSearchModal({ onPick, onClose }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<YtSearchResult[] | null>(null);
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
    setResults(null);
    setFailed(false);
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api
        .searchYoutube(term)
        .then((r) => {
          if (mine !== seq.current) return;
          setResults(r);
          setFailed(false);
          setIdx(0);
        })
        .catch(() => {
          if (mine === seq.current) setFailed(true);
        });
    }, 280);
    return () => clearTimeout(t);
  }, [q]);

  const querying = !!q.trim();
  const shown = querying ? (results ?? []) : [];

  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: "nearest" });
  }, [idx, shown]);

  function key(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(Math.max(shown.length - 1, 0), i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && shown[idx]) {
      e.preventDefault();
      onPick(shown[idx]);
    }
  }

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div
        className="palette yt-search"
        role="dialog"
        aria-modal="true"
        aria-label="Search YouTube"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input">
          <Search size={18} />
          <input
            autoFocus
            placeholder="Search YouTube…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={key}
            aria-label="YouTube search"
          />
          <kbd>Esc</kbd>
        </div>
        <p className="palette-label">
          {!querying
            ? "Type to search"
            : results
              ? `${results.length} found`
              : failed
                ? "Failed"
                : "Searching…"}
        </p>
        <ul ref={listRef} role="listbox">
          {failed && <li className="palette-empty">Search failed. Try again.</li>}
          {!failed && querying && results === null && (
            <li className="palette-empty">Searching…</li>
          )}
          {!failed && !querying && (
            <li className="palette-empty">Find a lecture, talk, or course.</li>
          )}
          {!failed && querying && results !== null && shown.length === 0 && (
            <li className="palette-empty">No videos found.</li>
          )}
          {shown.map((hit, i) => (
            <li key={hit.youtubeId} role="option" aria-selected={i === idx} data-sel={i === idx}>
              <button onMouseEnter={() => setIdx(i)} onClick={() => onPick(hit)}>
                <img
                  className="yt-search-thumb"
                  src={hit.thumb || `https://i.ytimg.com/vi/${hit.youtubeId}/mqdefault.jpg`}
                  alt=""
                  loading="lazy"
                  draggable={false}
                />
                <span className="pal-title">{hit.title}</span>
                {hit.channel && <span className="pal-meta">{hit.channel}</span>}
                {i === idx && <CornerDownLeft size={14} />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
