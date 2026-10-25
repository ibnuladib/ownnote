import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import { useHotkeys } from "react-hotkeys-hook";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, GripVertical, ListVideo, Plus, Search, SkipBack, SkipForward, Trash2 } from "lucide-react";
import type { NoteVideo, VideoStatus } from "@shared/types";
import { extractYoutubeId, youtubeWatchUrl } from "@shared/youtube";
import { api } from "../api";
import {
  YouTubePlayer,
  type PlayerState,
  type PlayRequest,
  type YouTubePlayerHandle,
} from "./YouTubePlayer";
import { YoutubeSearchModal, type YtSearchResult } from "./YoutubeSearchModal";

type Props = {
  noteId: string | null;
  preferredVideoId: string | null;
  onVideoSelected: (videoId: string) => void;
};

export type VideoPanelHandle = {
  seekTo: (seconds: number) => void;
  getCurrentTime: () => number;
  getYoutubeId: () => string | null;
  /** Soft-seek if already on this video; otherwise load then seek via PlayRequest. */
  jumpTo: (youtubeId: string, seconds: number) => void;
};

type Prog = { pos: number; dur: number };

const AUTOPLAY_KEY = "ownnote.autoplay";

function pctOf(v: NoteVideo, prog: Record<string, Prog>): number {
  if (v.status === "done") return 100;
  const p = prog[v.youtube_id];
  const pos = p?.pos ?? v.position_seconds ?? 0;
  const dur = p?.dur || v.duration_seconds || 0;
  return dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : 0;
}

export const VideoPanel = forwardRef<VideoPanelHandle, Props>(function VideoPanel(
  { noteId, preferredVideoId, onVideoSelected },
  ref,
) {
  const [videos, setVideos] = useState<NoteVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [request, setRequest] = useState<PlayRequest | null>(null);
  const [prog, setProg] = useState<Record<string, Prog>>({});
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoplay, setAutoplay] = useState(() => localStorage.getItem(AUTOPLAY_KEY) !== "off");

  const playerRef = useRef<YouTubePlayerHandle | null>(null);
  const videosRef = useRef(videos);
  videosRef.current = videos;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const autoplayRef = useRef(autoplay);
  autoplayRef.current = autoplay;
  const progRef = useRef(prog);
  progRef.current = prog;
  const nonce = useRef(0);
  const noteRef = useRef(noteId);
  noteRef.current = noteId;

  const startSecondsFor = useCallback((v: NoteVideo) => {
    const p = progRef.current[v.youtube_id];
    const dur = p?.dur || v.duration_seconds || 0;
    let start = p?.pos ?? v.position_seconds ?? 0;
    if (dur && start > dur - 5) start = 0;
    return Math.max(0, start);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const play = useCallback(
    (v: NoteVideo, autoStart: boolean, atSeconds?: number) => {
      setSelectedId(v.id);
      setRequest({
        youtubeId: v.youtube_id,
        startSeconds: atSeconds !== undefined ? Math.max(0, atSeconds) : startSecondsFor(v),
        play: autoStart,
        nonce: ++nonce.current,
      });
      onVideoSelected(v.id);
    },
    [onVideoSelected, startSecondsFor],
  );

  useImperativeHandle(
    ref,
    () => ({
      seekTo: (seconds) => playerRef.current?.seekTo(seconds),
      getCurrentTime: () => playerRef.current?.getCurrentTime() ?? 0,
      getYoutubeId: () => playerRef.current?.getYoutubeId() ?? null,
      jumpTo: (youtubeId, seconds) => {
        const current = playerRef.current?.getYoutubeId();
        if (current === youtubeId) {
          playerRef.current?.seekTo(seconds);
          return;
        }
        const v = videosRef.current.find((x) => x.youtube_id === youtubeId);
        if (v) play(v, true, seconds);
      },
    }),
    [play],
  );

  // Load videos when the note changes.
  useEffect(() => {
    setVideos([]);
    setSelectedId(null);
    setRequest(null);
    setProg({});
    setError(null);
    setUrl("");
    if (!noteId) return;
    let live = true;
    setLoading(true);
    api
      .listVideos(noteId)
      .then((list) => {
        if (!live) return;
        const sorted = [...list].sort((a, b) => a.sort_order - b.sort_order);
        setVideos(sorted);
        const pick =
          sorted.find((v) => v.id === preferredVideoId) ??
          sorted.find((v) => v.status === "in_progress") ??
          sorted.find((v) => v.status !== "done") ??
          sorted[0];
        if (pick) {
          setSelectedId(pick.id);
          const dur = pick.duration_seconds || 0;
          let start = pick.position_seconds ?? 0;
          if (dur && start > dur - 5) start = 0;
          setRequest({
            youtubeId: pick.youtube_id,
            startSeconds: start,
            play: false,
            nonce: ++nonce.current,
          });
        }
      })
      .catch(() => live && setError("Couldn't load the video list."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // preferredVideoId intentionally read once per note change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  const patchLocal = (id: string, patch: Partial<NoteVideo>) =>
    setVideos((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)));

  const setStatus = useCallback((v: NoteVideo, status: VideoStatus) => {
    if (v.status === status) return;
    patchLocal(v.id, { status });
    api.patchVideo(v.id, { status }).catch(() => {
      patchLocal(v.id, { status: v.status });
      setError("Couldn't update that video.");
    });
  }, []);

  const nextUnfinished = useCallback((fromId: string | null): NoteVideo | null => {
    const list = videosRef.current;
    const i = list.findIndex((v) => v.id === fromId);
    const order = [...list.slice(i + 1), ...list.slice(0, Math.max(i, 0))];
    return order.find((v) => v.status !== "done" && v.id !== fromId) ?? null;
  }, []);

  const onState = useCallback(
    (youtubeId: string, state: PlayerState) => {
      const cur = videosRef.current.find((v) => v.youtube_id === youtubeId);
      if (!cur) return;
      if (state === "playing" && cur.status === "unwatched") setStatus(cur, "in_progress");
      if (state === "ended") {
        setStatus(cur, "done");
        if (autoplayRef.current) {
          const next = nextUnfinished(cur.id);
          if (next) play(next, true);
        }
      }
    },
    [nextUnfinished, play, setStatus],
  );

  const onProgress = useCallback((youtubeId: string, pos: number, dur: number) => {
    setProg((p) => ({ ...p, [youtubeId]: { pos, dur } }));
  }, []);

  const onTitle = useCallback((youtubeId: string, title: string) => {
    const v = videosRef.current.find((x) => x.youtube_id === youtubeId);
    if (!v) return;
    const weak = !v.title || v.title === v.youtube_id || v.title === v.url || /^youtube/i.test(v.title);
    if (weak && title !== v.title) {
      patchLocal(v.id, { title });
      api.patchVideo(v.id, { title }).catch(() => {});
    }
  }, []);

  function step(dir: 1 | -1) {
    const list = videosRef.current;
    if (!list.length) return;
    const i = list.findIndex((v) => v.id === selectedRef.current);
    const next = list[(i + dir + list.length) % list.length];
    if (next) play(next, true);
  }
  useHotkeys("j,]", () => step(1), {
    preventDefault: true,
    enableOnFormTags: false,
    enableOnContentEditable: false,
  });
  useHotkeys("k,[", () => step(-1), {
    preventDefault: true,
    enableOnFormTags: false,
    enableOnContentEditable: false,
  });

  async function addUrl(raw: string) {
    if (!noteId) return;
    const id = extractYoutubeId(raw);
    if (!id) {
      setError("That doesn't look like a YouTube link.");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const v = await api.addVideo(noteId, raw.trim());
      if (noteRef.current !== noteId) return;
      setVideos((vs) => (vs.some((x) => x.id === v.id) ? vs : [...vs, v]));
      setUrl("");
      if (!selectedRef.current) play(v, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add the video.");
    } finally {
      setAdding(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (url.trim()) void addUrl(url);
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (extractYoutubeId(text)) {
      e.preventDefault();
      void addUrl(text);
    }
  }

  function pickSearch(hit: YtSearchResult) {
    setSearchOpen(false);
    void addUrl(youtubeWatchUrl(hit.youtubeId));
  }

  async function remove(v: NoteVideo) {
    const wasSelected = v.id === selectedRef.current;
    const prev = videosRef.current;
    const idx = prev.findIndex((x) => x.id === v.id);
    const remaining = prev.filter((x) => x.id !== v.id);
    setVideos(remaining);
    if (wasSelected) {
      const next = remaining[Math.min(idx, remaining.length - 1)];
      if (next) {
        setSelectedId(next.id);
        setRequest({
          youtubeId: next.youtube_id,
          startSeconds: startSecondsFor(next),
          play: false,
          nonce: ++nonce.current,
        });
      } else {
        setSelectedId(null);
        setRequest(null);
      }
    }
    try {
      await api.deleteVideo(v.id);
    } catch {
      setVideos(prev);
      setError("Couldn't delete that video.");
    }
  }

  function toggleDone(v: NoteVideo) {
    if (v.status === "done") {
      const p = prog[v.youtube_id];
      setStatus(v, (p?.pos ?? v.position_seconds ?? 0) > 5 ? "in_progress" : "unwatched");
    } else {
      setStatus(v, "done");
    }
  }

  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id || !noteId) return;
    const prev = videosRef.current;
    const from = prev.findIndex((v) => v.id === active.id);
    const to = prev.findIndex((v) => v.id === over.id);
    const moved = arrayMove(prev, from, to);
    setVideos(moved);
    try {
      const server = await api.reorderVideos(noteId, moved.map((v) => v.id));
      if (noteRef.current !== noteId) return;
      setVideos([...server].sort((a, b) => a.sort_order - b.sort_order));
    } catch {
      setVideos(prev);
      setError("Couldn't save the new order.");
    }
  }

  function toggleAutoplay() {
    const v = !autoplay;
    setAutoplay(v);
    localStorage.setItem(AUTOPLAY_KEY, v ? "on" : "off");
  }

  const current = videos.find((v) => v.id === selectedId) ?? null;
  const doneCount = useMemo(() => videos.filter((v) => v.status === "done").length, [videos]);
  const curProg = current ? prog[current.youtube_id] : undefined;

  return (
    <div className="watch-wrap">
      <header className="watch-head">
        <div className="list-title">
          <h2>Watch queue</h2>
          {videos.length > 0 && (
            <span className="count">
              {doneCount}/{videos.length}
            </span>
          )}
        </div>
        <label className="switch" title="Play the next unfinished video when one ends">
          <input type="checkbox" checked={autoplay} onChange={toggleAutoplay} />
          <span className="switch-track" />
          <span>Autoplay</span>
        </label>
      </header>

      <YouTubePlayer
        ref={playerRef}
        request={request}
        onState={onState}
        onProgress={onProgress}
        onTitle={onTitle}
      />

      <div className="now">
        <div className="now-text">
          <p className="now-title">{current ? current.title || current.url : "Nothing queued"}</p>
          <p className="now-time">
            {current
              ? current.status === "done"
                ? "done"
                : curProg?.dur
                  ? `${Math.round(((curProg.pos || 0) / curProg.dur) * 100)}% watched`
                  : "ready · click play"
              : "Add a link to build your queue"}
          </p>
        </div>
        <div className="now-ctl">
          <button
            className="icon-btn"
            onClick={() => step(-1)}
            disabled={videos.length < 2}
            aria-label="Previous video"
            title="Previous (K)"
          >
            <SkipBack size={16} />
          </button>
          <button
            className="icon-btn"
            onClick={() => step(1)}
            disabled={videos.length < 2}
            aria-label="Next video"
            title="Next (J)"
          >
            <SkipForward size={16} />
          </button>
        </div>
      </div>

      <form className="add-video" onSubmit={submit}>
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          onPaste={onPaste}
          placeholder="Paste a YouTube URL"
          aria-label="YouTube URL"
          disabled={!noteId || adding}
        />
        <button
          type="button"
          className="icon-btn"
          disabled={!noteId || adding}
          aria-label="Search YouTube"
          title="Search YouTube"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={18} />
        </button>
        <button type="submit" className="icon-btn solid" disabled={!url.trim() || adding} aria-label="Add video">
          <Plus size={18} />
        </button>
      </form>
      <p className="inline-error" role="alert">
        {error}
      </p>
      {searchOpen && (
        <YoutubeSearchModal onPick={pickSearch} onClose={() => setSearchOpen(false)} />
      )}

      <div className="video-scroll" aria-busy={loading}>
        {videos.length === 0 && !loading && (
          <div className="empty-videos">
            <ListVideo size={22} />
            <p>Lectures, talks, courses. Line them up and work through them in order.</p>
          </div>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={videos.map((v) => v.id)} strategy={verticalListSortingStrategy}>
            <ul className="video-list">
              {videos.map((v) => (
                <VideoRow
                  key={v.id}
                  video={v}
                  active={v.id === selectedId}
                  pct={pctOf(v, prog)}
                  onPlay={() => play(v, true)}
                  onDone={() => toggleDone(v)}
                  onDelete={() => remove(v)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </div>

      <footer className="watch-foot">
        <span><kbd>J</kbd>/<kbd>K</kbd> queue</span>
        <span><kbd>Ctrl</kbd>+<kbd>\</kbd> notes</span>
        <span><kbd>Ctrl</kbd>+<kbd>K</kbd> search</span>
      </footer>
    </div>
  );
});

function VideoRow(props: {
  video: NoteVideo;
  active: boolean;
  pct: number;
  onPlay: () => void;
  onDone: () => void;
  onDelete: () => void;
}) {
  const { video: v } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: v.id });
  const label = v.status === "done" ? "done" : v.status === "in_progress" ? "in progress" : "queued";

  return (
    <li
      ref={setNodeRef}
      className="video-row"
      data-active={props.active}
      data-status={v.status}
      data-dragging={isDragging}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button className="grip" aria-label={`Reorder ${v.title}`} {...attributes} {...listeners}>
        <GripVertical size={16} />
      </button>
      <button className="video-main" onClick={props.onPlay} aria-label={`Play ${v.title}`}>
        <img
          className="thumb"
          src={`https://i.ytimg.com/vi/${v.youtube_id}/mqdefault.jpg`}
          alt=""
          loading="lazy"
          draggable={false}
        />
        <span className="video-text">
          <span className="video-title">
            <span className="strike">{v.title || v.url}</span>
          </span>
          <span className="video-status">{label}{props.pct > 0 && v.status !== "done" ? ` · ${props.pct}%` : ""}</span>
        </span>
      </button>
      <div className="video-actions">
        <button
          className={`icon-btn sm ${v.status === "done" ? "is-on" : ""}`}
          onClick={props.onDone}
          aria-pressed={v.status === "done"}
          aria-label={v.status === "done" ? "Mark as not done" : "Cross out (done)"}
          title={v.status === "done" ? "Undo" : "Cross out"}
        >
          <Check size={15} />
        </button>
        <button className="icon-btn sm danger" onClick={props.onDelete} aria-label={`Delete ${v.title}`} title="Remove">
          <Trash2 size={14} />
        </button>
      </div>
      <span className="bar" aria-hidden="true">
        <span style={{ width: `${props.pct}%` }} />
      </span>
    </li>
  );
}
