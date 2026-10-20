/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import {
  ExternalLink,
  MonitorPlay,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Waypoints,
} from "lucide-react";
import { youtubeWatchUrl } from "@shared/youtube";
import { api } from "../api";
import { formatClock } from "../lib/time";
import { PROXY_INSTANCES, proxyEmbedUrl, youtubeEmbedUrl } from "../lib/youtubeFallback";

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
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const s = document.createElement("script");
        s.src = "https://www.youtube.com/iframe_api";
        s.async = true;
        s.onerror = () => {
          ytPromise = null;
          reject(new Error("YouTube API failed to load"));
        };
        document.head.appendChild(s);
      }
    });
  }
  return ytPromise;
}

export type PlayRequest = { youtubeId: string; play: boolean; nonce: number };
export type PlayerState = "playing" | "paused" | "ended" | "other";
type Mode = "youtube" | "proxy" | "iframe" | "theater";

type Props = {
  request: PlayRequest | null;
  onState: (youtubeId: string, state: PlayerState) => void;
  onProgress: (youtubeId: string, position: number, duration: number) => void;
  onTitle: (youtubeId: string, title: string) => void;
};

const SAVE_EVERY_MS = 4000;

/**
 * Multi-path player:
 * 1) Official YouTube IFrame API (best — resume + title)
 * 2) Direct nocookie embed iframe (often recovers autoplay with a click)
 * 3) Invidious proxy embeds (works when the uploader disabled YouTube embeds)
 * 4) Theater popup (watch.youtube.com window) as last resort
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
  const wantPlay = useRef(false);
  const theaterRef = useRef<Window | null>(null);
  const modeRef = useRef<Mode>("youtube");
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cb = useRef({ onState, onProgress, onTitle });
  cb.current = { onState, onProgress, onTitle };

  const [mode, setMode] = useState<Mode>("youtube");
  const [proxyIdx, setProxyIdx] = useState(0);
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [apiFailed, setApiFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [clock, setClock] = useState({ pos: 0, dur: 0 });
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const clearWatchdog = useCallback(() => {
    if (watchdog.current) {
      clearTimeout(watchdog.current);
      watchdog.current = null;
    }
  }, []);

  /** If autoplay is blocked, surface a click-to-play poster after a short wait. */
  const armAutoplayWatchdog = useCallback(() => {
    clearWatchdog();
    watchdog.current = setTimeout(() => {
      watchdog.current = null;
      if (modeRef.current !== "youtube") return;
      try {
        const st = playerRef.current?.getPlayerState?.();
        // 1 = PLAYING
        if (st !== 1) setNeedsGesture(true);
      } catch {
        setNeedsGesture(true);
      }
    }, 1100);
  }, [clearWatchdog]);

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

  const stopTick = useCallback(() => {
    clearInterval(tick.current);
    tick.current = undefined;
  }, []);

  const read = useCallback(() => {
    const p = playerRef.current;
    const id = curRef.current;
    if (!p || !id || typeof p.getCurrentTime !== "function") return;
    try {
      const pos = Number(p.getCurrentTime()) || 0;
      const dur = Number(p.getDuration()) || latest.current.dur;
      latest.current = { pos, dur };
      setClock({ pos, dur });
      cb.current.onProgress(id, pos, dur);
    } catch {
      /* mid-swap */
    }
  }, []);

  const startTick = useCallback(() => {
    stopTick();
    tick.current = setInterval(() => {
      read();
      scheduleSave();
    }, 500);
  }, [read, scheduleSave, stopTick]);

  const loadResume = useCallback(async (id: string) => {
    try {
      const w = await api.getWatch(id);
      const dur = w.duration_seconds ?? 0;
      let start = w.position_seconds ?? 0;
      if (dur && start > dur - 5) start = 0;
      return { start, dur };
    } catch {
      return { start: 0, dur: 0 };
    }
  }, []);

  const hushOfficial = useCallback(() => {
    stopTick();
    try {
      playerRef.current?.stopVideo?.();
    } catch {
      /* ignore */
    }
  }, [stopTick]);

  const switchToIframe = useCallback(
    async (id: string, reason: string) => {
      hushOfficial();
      const { start, dur } = await loadResume(id);
      latest.current = { pos: start, dur };
      setClock({ pos: start, dur });
      cb.current.onProgress(id, start, dur);
      modeRef.current = "iframe";
      setMode("iframe");
      setFallbackSrc(youtubeEmbedUrl(id, start));
      setBanner(reason);
      setNeedsGesture(false);
      setPlaying(true);
      cb.current.onState(id, "playing");
    },
    [hushOfficial, loadResume],
  );

  const switchToProxy = useCallback(
    async (id: string, index = 0) => {
      hushOfficial();
      const { start, dur } = await loadResume(id);
      latest.current = { pos: start, dur };
      setClock({ pos: start, dur });
      cb.current.onProgress(id, start, dur);
      const instance = PROXY_INSTANCES[index % PROXY_INSTANCES.length];
      setProxyIdx(index % PROXY_INSTANCES.length);
      modeRef.current = "proxy";
      setMode("proxy");
      setFallbackSrc(proxyEmbedUrl(instance, id, start));
      setBanner(`Playing via alternate player (${new URL(instance).hostname})`);
      setNeedsGesture(false);
      setPlaying(true);
      cb.current.onState(id, "playing");
    },
    [hushOfficial, loadResume],
  );

  const openTheater = useCallback(
    async (id: string) => {
      hushOfficial();
      const { start, dur } = await loadResume(id);
      latest.current = { pos: start, dur };
      setClock({ pos: start, dur });
      cb.current.onProgress(id, start, dur);
      const url = `${youtubeWatchUrl(id)}${start > 0 ? `&t=${Math.floor(start)}s` : ""}`;
      try {
        theaterRef.current?.close();
      } catch {
        /* ignore */
      }
      const w = window.open(
        url,
        "ownnote-theater",
        "popup=yes,width=960,height=540,menubar=no,toolbar=no,location=yes,status=no",
      );
      theaterRef.current = w;
      modeRef.current = "theater";
      setMode("theater");
      setFallbackSrc(null);
      setBanner("Opened YouTube theater — scrub below to save where you left off.");
      setPlaying(true);
      cb.current.onState(id, "playing");
    },
    [hushOfficial, loadResume],
  );

  const applyYoutube = useCallback(
    async (req: PlayRequest) => {
      const p = playerRef.current;
      if (!p || !readyRef.current) return;
      flushNow();
      stopTick();
      setBanner(null);
      setNeedsGesture(false);
      setPlaying(false);
      modeRef.current = "youtube";
      setMode("youtube");
      setFallbackSrc(null);
      const id = req.youtubeId;
      curRef.current = id;
      titled.current = null;
      wantPlay.current = req.play;
      const mine = ++token.current;
      const { start, dur } = await loadResume(id);
      if (mine !== token.current) return;
      latest.current = { pos: start, dur };
      setClock({ pos: start, dur });
      cb.current.onProgress(id, start, dur);
      const args = { videoId: id, startSeconds: Math.max(0, Math.floor(start)) };
      try {
        if (req.play) {
          // Prefer playing in the same tick as a user gesture when available.
          p.loadVideoById(args);
          try {
            p.unMute?.();
            p.playVideo?.();
            armAutoplayWatchdog();
          } catch {
            setNeedsGesture(true);
          }
        } else {
          p.cueVideoById(args);
          setNeedsGesture(true);
        }
      } catch {
        void switchToProxy(id, 0);
      }
    },
    [armAutoplayWatchdog, flushNow, loadResume, stopTick, switchToProxy],
  );

  // Create official player once.
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
          host: "https://www.youtube-nocookie.com",
          playerVars: {
            rel: 0,
            playsinline: 1,
            modestbranding: 1,
            enablejsapi: 1,
            origin: window.location.origin,
            widget_referrer: window.location.origin,
            autoplay: 0,
            fs: 1,
          },
          events: {
            onReady: () => {
              readyRef.current = true;
              if (pending.current) void applyYoutube(pending.current);
            },
            onStateChange: (e: { data: number }) => {
              const id = curRef.current;
              if (!id || modeRef.current !== "youtube") return;
              const S = YT.PlayerState;
              if (e.data === S.PLAYING) {
                clearWatchdog();
                setPlaying(true);
                setNeedsGesture(false);
                setBanner(null);
                startTick();
                cb.current.onState(id, "playing");
              } else if (e.data === S.PAUSED) {
                setPlaying(false);
                stopTick();
                read();
                flushNow();
                cb.current.onState(id, "paused");
              } else if (e.data === S.ENDED) {
                clearWatchdog();
                setPlaying(false);
                stopTick();
                const d = Number(playerRef.current?.getDuration?.()) || latest.current.dur;
                latest.current = { pos: d, dur: d };
                setClock({ pos: d, dur: d });
                cb.current.onProgress(id, d, d);
                flushNow();
                cb.current.onState(id, "ended");
              } else if (e.data === S.CUED) {
                setPlaying(false);
                if (wantPlay.current) {
                  wantPlay.current = false;
                  try {
                    playerRef.current?.playVideo?.();
                    armAutoplayWatchdog();
                  } catch {
                    setNeedsGesture(true);
                  }
                }
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
            onError: (e: { data: number }) => {
              const id = curRef.current;
              if (!id) return;
              stopTick();
              setPlaying(false);
              // 101/150 = embedding disabled → proxy. Others → try iframe then proxy.
              if (e.data === 101 || e.data === 150) {
                void switchToProxy(id, 0);
              } else if (e.data === 100) {
                setBanner("This video is unavailable on YouTube.");
              } else {
                void switchToIframe(id, "Official embed hiccuped — trying a direct player…");
              }
            },
          },
        });
      })
      .catch(() => !cancelled && setApiFailed(true));

    const onHide = () => flushNow(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onHide);
      clearWatchdog();
      stopTick();
      flushNow();
      readyRef.current = false;
      try {
        playerRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      if (hostRef.current) hostRef.current.innerHTML = "";
      try {
        theaterRef.current?.close();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    pending.current = request;
    if (!request) {
      token.current++;
      flushNow();
      curRef.current = null;
      stopTick();
      setPlaying(false);
      setClock({ pos: 0, dur: 0 });
      setFallbackSrc(null);
      setBanner(null);
      setNeedsGesture(false);
      setMode("youtube");
      try {
        playerRef.current?.stopVideo?.();
      } catch {
        /* ignore */
      }
      try {
        theaterRef.current?.close();
      } catch {
        /* ignore */
      }
      return;
    }
    curRef.current = request.youtubeId;
    if (apiFailed) {
      void switchToProxy(request.youtubeId, 0);
      return;
    }
    if (readyRef.current) void applyYoutube(request);
  }, [request, applyYoutube, apiFailed, flushNow, stopTick, switchToProxy]);

  const togglePlay = () => {
    const id = curRef.current;
    if (!id) return;
    if (mode === "youtube") {
      const p = playerRef.current;
      if (!p) return;
      try {
        if (playing) p.pauseVideo();
        else {
          p.unMute?.();
          p.playVideo();
          setNeedsGesture(false);
        }
      } catch {
        setNeedsGesture(true);
      }
      return;
    }
    if (mode === "theater") {
      openTheater(id);
      return;
    }
    // proxy/iframe: remount with autoplay
    setPlaying((p) => !p);
    if (!playing) {
      const start = latest.current.pos;
      setFallbackSrc(
        mode === "proxy"
          ? proxyEmbedUrl(PROXY_INSTANCES[proxyIdx], id, start)
          : youtubeEmbedUrl(id, start),
      );
      cb.current.onState(id, "playing");
    }
  };

  const forceGesturePlay = () => {
    const id = curRef.current;
    if (!id) return;
    clearWatchdog();
    setNeedsGesture(false);
    if (mode === "youtube") {
      try {
        playerRef.current?.unMute?.();
        playerRef.current?.playVideo?.();
        armAutoplayWatchdog();
        // If the official player still won't start, escalate under this gesture.
        window.setTimeout(() => {
          if (modeRef.current !== "youtube") return;
          try {
            if (playerRef.current?.getPlayerState?.() !== 1) {
              void switchToIframe(id, "Starting via direct embed (autoplay-safe)…");
            }
          } catch {
            void switchToIframe(id, "Starting via direct embed (autoplay-safe)…");
          }
        }, 900);
      } catch {
        void switchToIframe(id, "Click-to-play via direct embed");
      }
      return;
    }
    togglePlay();
  };

  const seekBy = (delta: number) => {
    if (mode !== "youtube") {
      const next = Math.max(0, latest.current.pos + delta);
      const dur = latest.current.dur;
      latest.current = { pos: next, dur };
      setClock({ pos: next, dur });
      scheduleSave();
      const id = curRef.current;
      if (id && (mode === "proxy" || mode === "iframe")) {
        setFallbackSrc(
          mode === "proxy"
            ? proxyEmbedUrl(PROXY_INSTANCES[proxyIdx], id, next)
            : youtubeEmbedUrl(id, next),
        );
      }
      return;
    }
    const p = playerRef.current;
    if (!p) return;
    try {
      const next = Math.max(0, (Number(p.getCurrentTime()) || 0) + delta);
      const dur = Number(p.getDuration()) || 0;
      p.seekTo(dur ? Math.min(next, Math.max(0, dur - 0.25)) : next, true);
      read();
      scheduleSave();
    } catch {
      /* ignore */
    }
  };

  const onScrub = (e: ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.target.value);
    const dur = clock.dur || latest.current.dur;
    latest.current = { pos: next, dur };
    setClock({ pos: next, dur });
    scheduleSave();
    const id = curRef.current;
    if (mode === "youtube") {
      try {
        playerRef.current?.seekTo(next, true);
      } catch {
        /* ignore */
      }
      return;
    }
    if (id && (mode === "proxy" || mode === "iframe")) {
      setFallbackSrc(
        mode === "proxy"
          ? proxyEmbedUrl(PROXY_INSTANCES[proxyIdx], id, next)
          : youtubeEmbedUrl(id, next),
      );
    }
  };

  const restart = () => {
    latest.current = { pos: 0, dur: latest.current.dur };
    setClock({ pos: 0, dur: latest.current.dur });
    if (mode === "youtube") {
      try {
        playerRef.current?.seekTo(0, true);
        playerRef.current?.playVideo?.();
      } catch {
        /* ignore */
      }
      return;
    }
    const id = curRef.current;
    if (id && (mode === "proxy" || mode === "iframe")) {
      setFallbackSrc(
        mode === "proxy" ? proxyEmbedUrl(PROXY_INSTANCES[proxyIdx], id, 0) : youtubeEmbedUrl(id, 0),
      );
      setPlaying(true);
    }
  };

  const tryNextProxy = () => {
    const id = curRef.current;
    if (!id) return;
    void switchToProxy(id, proxyIdx + 1);
  };

  const id = request?.youtubeId ?? null;
  const pct = clock.dur > 0 ? (clock.pos / clock.dur) * 100 : 0;
  const showYoutubeHost = mode === "youtube" && !!request;
  const showFallbackFrame = (mode === "proxy" || mode === "iframe") && !!fallbackSrc;

  return (
    <div className="player-shell">
      <div
        className="player-frame"
        data-empty={!request}
        data-mode={mode}
      >
        <div ref={hostRef} className="player-host" data-active={showYoutubeHost || undefined} />
        {showFallbackFrame && (
          <iframe
            key={fallbackSrc}
            className="player-fallback"
            src={fallbackSrc!}
            title="Video player"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        )}
        {mode === "theater" && id && (
          <div className="player-block">
            <p className="player-block-title">Theater mode</p>
            <p className="player-block-copy">
              Playing in a YouTube window. Keep this tab open and use the scrubber to save progress.
            </p>
            <button type="button" className="btn-primary" onClick={() => openTheater(id)}>
              <MonitorPlay size={16} />
              Re-open theater
            </button>
          </div>
        )}
        {!request && !apiFailed && (
          <p className="player-hint">Paste a YouTube link below to start a queue.</p>
        )}
        {needsGesture && id && mode === "youtube" && (
          <button
            type="button"
            className="player-gesture"
            onClick={forceGesturePlay}
            style={
              {
                "--poster": `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)`,
              } as CSSProperties
            }
          >
            <span className="player-gesture-disc" aria-hidden>
              <Play size={28} fill="currentColor" />
            </span>
            <span>Click to play</span>
            <span className="player-gesture-sub">Uses your click so the browser allows sound</span>
          </button>
        )}
      </div>

      {banner && (
        <div className="player-banner" role="status">
          <span>{banner}</span>
          <div className="player-banner-actions">
            {mode !== "proxy" && id && (
              <button type="button" className="text-btn" onClick={() => void switchToProxy(id, 0)}>
                <Waypoints size={14} /> Alt player
              </button>
            )}
            {mode === "proxy" && id && (
              <button type="button" className="text-btn" onClick={tryNextProxy}>
                Try next mirror
              </button>
            )}
            {id && (
              <button type="button" className="text-btn" onClick={() => void openTheater(id)}>
                <MonitorPlay size={14} /> Theater
              </button>
            )}
          </div>
        </div>
      )}

      <div className="player-controls" data-disabled={!request}>
        <button
          type="button"
          className="icon-btn"
          onClick={() => seekBy(-10)}
          disabled={!request}
          aria-label="Back 10 seconds"
          title="-10s"
        >
          <SkipBack size={16} />
        </button>
        <button
          type="button"
          className="icon-btn solid"
          onClick={togglePlay}
          disabled={!request}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => seekBy(10)}
          disabled={!request}
          aria-label="Forward 10 seconds"
          title="+10s"
        >
          <SkipForward size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={restart}
          disabled={!request}
          aria-label="Restart"
          title="Restart"
        >
          <RotateCcw size={15} />
        </button>
        <input
          className="player-scrub"
          type="range"
          min={0}
          max={Math.max(1, clock.dur || 1)}
          step={0.25}
          value={Math.min(clock.pos, clock.dur || clock.pos)}
          onChange={onScrub}
          disabled={!request}
          aria-label="Seek"
          style={{ "--pct": `${pct}%` } as CSSProperties}
        />
        <span className="player-clock">
          {request ? `${formatClock(clock.pos)} / ${formatClock(clock.dur)}` : "–:––"}
        </span>
        {id && (
          <>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void switchToProxy(id, mode === "proxy" ? proxyIdx + 1 : 0)}
              aria-label="Alternate player"
              title="Alternate player (bypasses embed blocks)"
            >
              <Waypoints size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void openTheater(id)}
              aria-label="Theater window"
              title="Open YouTube theater window"
            >
              <MonitorPlay size={15} />
            </button>
            <a
              className="icon-btn"
              href={youtubeWatchUrl(id)}
              target="_blank"
              rel="noreferrer"
              aria-label="Open on YouTube"
              title="Open on YouTube"
            >
              <ExternalLink size={15} />
            </a>
          </>
        )}
      </div>
    </div>
  );
}
