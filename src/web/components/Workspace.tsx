import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { BookOpen, ChevronDown, Download, LogOut, PenLine, Search, Tv } from "lucide-react";
import type { Note, NoteSummary, TemplateMeta, TipTapJSON } from "@shared/types";
import { TEMPLATES } from "@shared/templates";
import { api, exportUrl } from "../api";
import { parseDate } from "../lib/time";
import { Saver, type SaveState } from "../lib/saver";
import { NoteList } from "./NoteList";
import { NoteEditor } from "./NoteEditor";
import { VideoPanel } from "./VideoPanel";
import { SearchPalette } from "./SearchPalette";

type Pane = "notes" | "write" | "watch";

function sortNotes(list: NoteSummary[]): NoteSummary[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) return parseDate(b.pinned_at) - parseDate(a.pinned_at);
    return parseDate(b.updated_at) - parseDate(a.updated_at);
  });
}

const toSummary = (n: Note): NoteSummary => ({
  id: n.id,
  title: n.title,
  pinned: n.pinned,
  pinned_at: n.pinned_at,
  last_opened_at: n.last_opened_at,
  updated_at: n.updated_at,
  tags: n.tags,
});

const SAVE_LABEL: Record<SaveState, string> = {
  idle: "",
  dirty: "unsaved",
  saving: "saving",
  saved: "saved",
  error: "retrying…",
};

export function Workspace({ onLogout }: { onLogout: () => void }) {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [templates, setTemplates] = useState<TemplateMeta[]>(TEMPLATES);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [booting, setBooting] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [pane, setPane] = useState<Pane>("write");
  const [searchOpen, setSearchOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const selectedRef = useRef<string | null>(null);
  const lastVideoRef = useRef<string | null>(null);
  const [preferredVideo, setPreferredVideo] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exportRef = useRef<HTMLDivElement>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const saver = useMemo(
    () =>
      new Saver(800, {
        onStatus: setSaveState,
        onSaved: (n) =>
          setNotes((list) =>
            // Keep local title/tags (the user may have typed more since this PATCH left).
            sortNotes(list.map((x) => (x.id === n.id ? { ...x, updated_at: n.updated_at } : x))),
          ),
      }),
    [],
  );

  const refreshTags = useCallback(() => {
    api
      .listTags()
      .then((t) => setTags(t.map((x) => x.name)))
      .catch(() => {});
  }, []);

  const loadNote = useCallback(
    async (id: string) => {
      selectedRef.current = id;
      setSelectedId(id);
      setNote(null);
      try {
        const n = await api.getNote(id);
        if (selectedRef.current !== id) return;
        setNote(n);
      } catch {
        if (selectedRef.current !== id) return;
        notify("That note couldn't be opened.");
        setSelectedId(null);
        selectedRef.current = null;
      }
    },
    [notify],
  );

  const selectNote = useCallback(
    (id: string) => {
      setSearchOpen(false);
      setPane("write");
      if (id === selectedRef.current) return;
      void saver.flush();
      void loadNote(id);
      api.putPrefs({ last_note_id: id }).catch(() => {});
    },
    [loadNote, saver],
  );

  // Initial load: notes, tags, prefs, templates.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [list, prefs] = await Promise.all([api.listNotes(), api.getPrefs().catch(() => null)]);
        if (!live) return;
        const sorted = sortNotes(list);
        setNotes(sorted);
        lastVideoRef.current = prefs?.last_video_id ?? null;
        setPreferredVideo(prefs?.last_video_id ?? null);
        const start = sorted.find((n) => n.id === prefs?.last_note_id) ?? sorted[0];
        if (start) void loadNote(start.id);
      } catch {
        notify("Couldn't load your notes.");
      } finally {
        if (live) setBooting(false);
      }
    })();
    refreshTags();
    api.templates().then((t) => live && t.length && setTemplates(t)).catch(() => {});
    return () => {
      live = false;
    };
  }, [loadNote, notify, refreshTags]);

  // Tag filter.
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    let live = true;
    setListLoading(true);
    api
      .listNotes(activeTag)
      .then((l) => live && setNotes(sortNotes(l)))
      .catch(() => live && notify("Couldn't filter notes."))
      .finally(() => live && setListLoading(false));
    return () => {
      live = false;
    };
  }, [activeTag, notify]);

  // Flush edits when leaving.
  useEffect(() => {
    const flush = () => void saver.flush(true);
    const warn = (e: BeforeUnloadEvent) => {
      if (saver.dirty) e.preventDefault();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", warn);
    };
  }, [saver]);

  // Close export menu on outside click.
  useEffect(() => {
    if (!exportOpen) return;
    const close = (e: MouseEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [exportOpen]);

  const createBlank = useCallback(async () => {
    try {
      void saver.flush();
      const n = await api.createNote("Untitled");
      setNotes((l) => sortNotes([toSummary(n), ...l.filter((x) => x.id !== n.id)]));
      selectedRef.current = n.id;
      setSelectedId(n.id);
      setNote(n);
      setPane("write");
      api.putPrefs({ last_note_id: n.id }).catch(() => {});
    } catch {
      notify("Couldn't create a note.");
    }
  }, [notify, saver]);

  const createFromTemplate = useCallback(
    async (key: string, name: string) => {
      try {
        void saver.flush();
        const n = await api.createFromTemplate(key, name === "Learning journey" ? "New learning journey" : name);
        setNotes((l) => sortNotes([toSummary(n), ...l.filter((x) => x.id !== n.id)]));
        selectedRef.current = n.id;
        setSelectedId(n.id);
        setNote(n);
        setPane("write");
        api.putPrefs({ last_note_id: n.id }).catch(() => {});
      } catch {
        notify("Couldn't create from template.");
      }
    },
    [notify, saver],
  );

  const onTitle = useCallback(
    (id: string, title: string) => {
      setNotes((l) => l.map((n) => (n.id === id ? { ...n, title } : n)));
      saver.queue(id, { title });
    },
    [saver],
  );

  const onContent = useCallback(
    (id: string, content: TipTapJSON) => saver.queue(id, { content }),
    [saver],
  );

  const onPin = useCallback(
    async (n: NoteSummary) => {
      const pinned = !n.pinned;
      const stamp = pinned ? new Date().toISOString() : null;
      const apply = (p: boolean, at: string | null) => {
        setNotes((l) => sortNotes(l.map((x) => (x.id === n.id ? { ...x, pinned: p, pinned_at: at } : x))));
        setNote((cur) => (cur && cur.id === n.id ? { ...cur, pinned: p, pinned_at: at } : cur));
      };
      apply(pinned, stamp);
      try {
        const saved = await api.patchNote(n.id, { pinned });
        apply(saved.pinned, saved.pinned_at);
      } catch {
        apply(n.pinned, n.pinned_at);
        notify("Couldn't update the pin.");
      }
    },
    [notify],
  );

  const onDelete = useCallback(
    async (n: Note) => {
      saver.drop(n.id);
      try {
        await api.deleteNote(n.id);
      } catch {
        notify("Couldn't delete the note.");
        return;
      }
      const remaining = notes.filter((x) => x.id !== n.id);
      setNotes(remaining);
      refreshTags();
      const idx = notes.findIndex((x) => x.id === n.id);
      const next = remaining[Math.min(idx, remaining.length - 1)];
      if (next) {
        void loadNote(next.id);
        api.putPrefs({ last_note_id: next.id }).catch(() => {});
      } else {
        selectedRef.current = null;
        setSelectedId(null);
        setNote(null);
        api.putPrefs({ last_note_id: null }).catch(() => {});
      }
    },
    [loadNote, notes, notify, refreshTags, saver],
  );

  const onTags = useCallback(
    async (n: Note, next: string[]) => {
      const prev = n.tags;
      const apply = (t: string[]) => {
        setNote((cur) => (cur && cur.id === n.id ? { ...cur, tags: t } : cur));
        setNotes((l) => l.map((x) => (x.id === n.id ? { ...x, tags: t } : x)));
      };
      apply(next);
      try {
        apply(await api.setTags(n.id, next));
        refreshTags();
      } catch {
        apply(prev);
        notify("Couldn't save tags.");
      }
    },
    [notify, refreshTags],
  );

  const onVideoSelected = useCallback((videoId: string) => {
    if (lastVideoRef.current === videoId) return;
    lastVideoRef.current = videoId;
    setPreferredVideo(videoId);
    api.putPrefs({ last_video_id: videoId }).catch(() => {});
  }, []);

  // Keyboard shortcuts (work while typing, except the video keys inside VideoPanel).
  const both = { enableOnFormTags: true, enableOnContentEditable: true, preventDefault: true } as const;
  useHotkeys("mod+k", () => setSearchOpen((o) => !o), both);
  useHotkeys("alt+n", () => void createBlank(), both);
  useHotkeys(
    "mod+s",
    () => {
      void saver.flush().then(() => notify("Saved"));
    },
    both,
  );

  const tagNames = tags;
  const recent = useMemo(() => notes, [notes]);

  return (
    <div className="app" data-pane={pane}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            own<span className="hl-word">note</span>
          </span>
        </div>
        <div className="topbar-right">
          <span className="save-state" data-state={saveState} role="status" aria-live="polite">
            <i />
            {SAVE_LABEL[saveState]}
          </span>
          <button className="top-btn" onClick={() => setSearchOpen(true)} aria-label="Search (Ctrl+K)">
            <Search size={16} />
            <span className="hide-sm">Search</span>
          </button>
          <div className="export-wrap" ref={exportRef}>
            <button
              className="top-btn"
              onClick={() => setExportOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
            >
              <Download size={16} />
              <span className="hide-sm">Export</span>
              <ChevronDown size={13} />
            </button>
            {exportOpen && (
              <div className="menu menu-right" role="menu">
                <a role="menuitem" href={exportUrl("json")} download onClick={() => setExportOpen(false)}>
                  <b>JSON</b>
                  <small>Everything, re-importable</small>
                </a>
                <a role="menuitem" href={exportUrl("markdown")} download onClick={() => setExportOpen(false)}>
                  <b>Markdown</b>
                  <small>Readable anywhere</small>
                </a>
              </div>
            )}
          </div>
          <button className="top-btn" onClick={onLogout} aria-label="Log out" title="Log out">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      <main className="main">
        <aside className="pane pane-notes" aria-label="Notes">
          <NoteList
            notes={recent}
            tags={tagNames}
            activeTag={activeTag}
            selectedId={selectedId}
            templates={templates}
            loading={booting || listLoading}
            onSelect={selectNote}
            onPin={onPin}
            onTag={setActiveTag}
            onNew={() => void createBlank()}
            onNewFromTemplate={(k, n) => void createFromTemplate(k, n)}
            onSearch={() => setSearchOpen(true)}
          />
        </aside>

        <section className="pane pane-write" aria-label="Editor">
          {note ? (
            <div className="editor-anim" key={note.id}>
              <NoteEditor
                note={note}
                allTags={tagNames}
                onTitle={onTitle}
                onContent={onContent}
                onPin={onPin}
                onDelete={onDelete}
                onTags={onTags}
              />
            </div>
          ) : (
            <div className="blank-state">
              {booting || selectedId ? (
                <p className="blank-hint">Opening…</p>
              ) : (
                <>
                  <p className="blank-big">Nothing open.</p>
                  <button className="btn-primary" onClick={() => void createBlank()}>
                    New note
                  </button>
                </>
              )}
            </div>
          )}
        </section>

        <section className="pane pane-watch" aria-label="YouTube">
          <VideoPanel noteId={note?.id ?? null} preferredVideoId={preferredVideo} onVideoSelected={onVideoSelected} />
        </section>
      </main>

      <nav className="tabbar" aria-label="Sections">
        <button data-on={pane === "notes"} onClick={() => setPane("notes")}>
          <BookOpen size={19} />
          <span>Notes</span>
        </button>
        <button data-on={pane === "write"} onClick={() => setPane("write")}>
          <PenLine size={19} />
          <span>Write</span>
        </button>
        <button data-on={pane === "watch"} onClick={() => setPane("watch")}>
          <Tv size={19} />
          <span>Watch</span>
        </button>
      </nav>

      {searchOpen && (
        <SearchPalette recent={recent} onPick={selectNote} onClose={() => setSearchOpen(false)} />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
