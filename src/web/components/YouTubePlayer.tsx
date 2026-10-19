/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytPromise: Promise<any> | null = null;
function loadYT(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!ytPromise) {
    ytPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve(window.YT);
      };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      s.onerror = () => {
        ytPromise = null;
        reject(new Error("YouTube API failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return ytPromise;
}

export type PlayRequest = { youtubeId: string; play: boolean; nonce: number };
export type PlayerState = "playing" | "paused" | "ended" | "other";

type Props = {
  request: PlayRequest | null;
  onState: (youtubeId: string, state: PlayerState) => void;
  onProgress: (youtubeId: string, position: number, duration: number) => void;
  onTitle: (youtubeId: string, title: string) => void;
};

const SAVE_EVERY_MS = 5000;

/**
 * One persistent YouTube IFrame player. Resume position is read from
 * GET /api/watch/:id; progress is written (throttled) with PUT /api/watch/:id.
 */
export function YouTubePlayer({ request, onState, onProgress, onTitle }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const readyRef = useRef(false);
  const curRef = useRef<string | null>(null);
  const latest = useRef({ pos: 0, dur: 0 });
  const tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const token = useRef(0);
  const titled = useRef<string | null>(null);
  const pending = useRef<PlayRequest | null>(request);
  const cb = useRef({ onState, onProgress, onTitle });
  cb.current = { onState, onProgress, onTitle };
  const [error, setError] = useState(false);

  const persist = useCallback((keepalive = false) => {
    const id = curRef.current;
    const { pos, dur } = latest.current;
    if (!id || (!pos && !dur)) return;
    api
      .putWatch(
        id,
        { position_seconds: Math.floor(pos), ...(dur ? { duration_seconds: Math.floor(dur) } : {}) },
        keepalive,
      )
      .catch(() => {});
  }, []);

  const flushNow = useCallback(
    (keepalive = false) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      persist(keepalive);
    },
    [persist],
  );

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) return;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      persist();
    }, SAVE_EVERY_MS);
  }, [persist]);

  const read = useCallback(() => {
    const p = playerRef.current;
    const id = curRef.current;
    if (!p || !id || typeof p.getCurrentTime !== "function") return;
    const pos = Number(p.getCurrentTime()) || 0;
    const dur = Number(p.getDuration()) || latest.current.dur;
    latest.current = { pos, dur };
    cb.current.onProgress(id, pos, dur);
  }, []);

  const apply = useCallback(
    async (req: PlayRequest) => {
      const p = playerRef.current;
      if (!p) return;
      flushNow();
      clearInterval(tick.current);
      const id = req.youtubeId;
      curRef.current = id;
      titled.current = null;
      latest.current = { pos: 0, dur: 0 };
      const mine = ++token.current;

      let start = 0;
      let dur = 0;
      try {
        const w = await api.getWatch(id);
        dur = w.duration_seconds ?? 0;
        start = w.position_seconds ?? 0;
        if (dur && start > dur - 5) start = 0; // finished last time: restart
      } catch {
        /* no saved progress */
      }
      if (mine !== token.current) return;
      latest.current = { pos: start, dur };
      cb.current.onProgress(id, start, dur);
      const args = { videoId: id, startSeconds: Math.floor(start) };
      if (req.play) p.loadVideoById(args);
      else p.cueVideoById(args);
    },
    [flushNow],
  );

  // Create the player once.
  useEffect(() => {
    let cancelled = false;
    loadYT()
      .then((YT) => {
        if (cancelled || !hostRef.current) return;
        const el = document.createElement("div");
        hostRef.current.appendChild(el);
        playerRef.current = new YT.Player(el, {
          width: "100%",
          height: "100%",
          playerVars: { rel: 0, playsinline: 1, modestbranding: 1, origin: window.location.origin },
          events: {
            onReady: () => {
              readyRef.current = true;
              if (pending.current) void apply(pending.current);
            },
            onStateChange: (e: { data: number }) => {
              const id = curRef.current;
              if (!id) return;
              const S = YT.PlayerState;
              if (e.data === S.PLAYING) {
                clearInterval(tick.current);
                tick.current = setInterval(() => {
                  read();
                  scheduleSave();
                }, 1000);
                cb.current.onState(id, "playing");
              } else if (e.data === S.PAUSED) {
                clearInterval(tick.current);
                read();
                flushNow();
                cb.current.onState(id, "paused");
              } else if (e.data === S.ENDED) {
                clearInterval(tick.current);
                const dur = Number(playerRef.current?.getDuration?.()) || latest.current.dur;
                latest.current = { pos: dur, dur };
                cb.current.onProgress(id, dur, dur);
                flushNow();
                cb.current.onState(id, "ended");
              } else {
                cb.current.onState(id, "other");
              }
              if ((e.data === S.CUED || e.data === S.PLAYING) && titled.current !== id) {
                const t = playerRef.current?.getVideoData?.()?.title;
                if (t) {
                  titled.current = id;
                  cb.current.onTitle(id, t);
                }
              }
            },
            onError: () => setError(true),
          },
        });
      })
      .catch(() => !cancelled && setError(true));

    const onHide = () => flushNow(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onHide);
      clearInterval(tick.current);
      flushNow();
      readyRef.current = false;
      try {
        playerRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      if (hostRef.current) hostRef.current.innerHTML = "";
    };
  }, [apply, flushNow, read, scheduleSave]);

  // React to play requests.
  useEffect(() => {
    pending.current = request;
    if (!request) {
      token.current++;
      flushNow();
      curRef.current = null;
      clearInterval(tick.current);
      try {
        playerRef.current?.stopVideo?.();
      } catch {
        /* ignore */
      }
      return;
    }
    if (readyRef.current) void apply(request);
  }, [request, apply, flushNow]);

  return (
    <div className="player-frame" data-empty={!request}>
      <div ref={hostRef} className="player-host" />
      {!request && !error && <p className="player-hint">Paste a YouTube link below to start a queue.</p>}
      {error && <p className="player-hint">The YouTube player could not load. Check your connection.</p>}
    </div>
  );
}
