import { useEffect, useRef, useState } from "react";
import { FilePlus2, Map as MapIcon, Search, Star } from "lucide-react";
import type { NoteSummary, TemplateMeta } from "@shared/types";
import { relativeTime } from "../lib/time";

type Props = {
  notes: NoteSummary[];
  tags: string[];
  activeTag: string | null;
  selectedId: string | null;
  templates: TemplateMeta[];
  loading: boolean;
  onSelect: (id: string) => void;
  onPin: (n: NoteSummary) => void;
  onTag: (tag: string | null) => void;
  onNew: () => void;
  onNewFromTemplate: (key: string, name: string) => void;
  onSearch: () => void;
};

export function NoteList(p: Props) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const pinned = p.notes.filter((n) => n.pinned);
  const rest = p.notes.filter((n) => !n.pinned);

  const row = (n: NoteSummary, i: number) => (
    <li
      key={n.id}
      className="note-row rise"
      style={{ "--i": Math.min(i, 8) } as React.CSSProperties}
      data-active={n.id === p.selectedId}
    >
      <button className="note-row-main" onClick={() => p.onSelect(n.id)}>
        <span className="note-row-title">{n.title.trim() || "Untitled"}</span>
        <span className="note-row-meta">
          <time>{relativeTime(n.updated_at)}</time>
          {n.tags.slice(0, 3).map((t) => (
            <span key={t} className="note-row-tag">
              #{t}
            </span>
          ))}
        </span>
      </button>
      <button
        className={`row-pin ${n.pinned ? "is-on" : ""}`}
        onClick={() => p.onPin(n)}
        aria-label={n.pinned ? `Unpin ${n.title}` : `Pin ${n.title}`}
        aria-pressed={n.pinned}
      >
        <Star size={14} fill={n.pinned ? "currentColor" : "none"} />
      </button>
    </li>
  );

  return (
    <div className="list-wrap">
      <div className="list-head">
        <div className="list-title">
          <h2>Notebook</h2>
          <span className="count">{p.notes.length}</span>
        </div>
        <div className="new-wrap" ref={menuRef}>
          <button
            className="btn-new"
            onClick={() => setMenu((m) => !m)}
            aria-haspopup="menu"
            aria-expanded={menu}
            title="New note (Alt+N)"
          >
            <FilePlus2 size={16} />
            <span>New</span>
          </button>
          {menu && (
            <div className="menu" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  p.onNew();
                }}
              >
                <FilePlus2 size={16} />
                <span>
                  <b>Blank note</b>
                  <small>Alt+N</small>
                </span>
              </button>
              {p.templates.map((t) => (
                <button
                  role="menuitem"
                  key={t.key}
                  onClick={() => {
                    setMenu(false);
                    p.onNewFromTemplate(t.key, t.name);
                  }}
                >
                  <MapIcon size={16} />
                  <span>
                    <b>{t.name}</b>
                    <small>{t.description}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <button className="search-trigger" onClick={p.onSearch}>
        <Search size={15} />
        <span>Search notes</span>
        <kbd>Ctrl K</kbd>
      </button>

      {p.tags.length > 0 && (
        <div className="tag-filter" role="group" aria-label="Filter by tag">
          <button data-on={p.activeTag === null} onClick={() => p.onTag(null)}>
            all
          </button>
          {p.tags.map((t) => (
            <button key={t} data-on={p.activeTag === t} onClick={() => p.onTag(p.activeTag === t ? null : t)}>
              #{t}
            </button>
          ))}
        </div>
      )}

      <div className="list-scroll" aria-busy={p.loading}>
        {p.notes.length === 0 && !p.loading && (
          <div className="empty-list">
            <p>{p.activeTag ? `Nothing tagged #${p.activeTag}.` : "A blank notebook."}</p>
            {!p.activeTag && <button className="btn-primary" onClick={p.onNew}>Write the first note</button>}
          </div>
        )}
        {pinned.length > 0 && (
          <>
            <h3 className="list-label">Pinned</h3>
            <ul>{pinned.map(row)}</ul>
          </>
        )}
        {rest.length > 0 && (
          <>
            {pinned.length > 0 && <h3 className="list-label">Recent</h3>}
            <ul>{rest.map((n, i) => row(n, i + pinned.length))}</ul>
          </>
        )}
      </div>
    </div>
  );
}
