/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { ExternalLink, Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { youtubeWatchUrl } from "@shared/youtube";
import { api } from "../api";
import { formatClock } from "../lib/time";

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

export type PlayRequest = {
  youtubeId: string;
  startSeconds: number;
  play: boolean;
  nonce: number;
};

export type PlayerState = "playing" | "paused" | "ended" | "other";

type Props = {
  request: PlayRequest | null;
  onState: (youtubeId: string, state: PlayerState) => void;
  onProgress: (youtubeId: string, position: number, duration: number) => void;
  onTitle: (youtubeId: string, title: string) => void;
};

type Phase =
  | "idle"
  | "ready"
  | "playing"
  | "paused"
  | "ended"
  | "direct"
  | "direct_loading"
  | "blocked"
  | "api_missing";

type Session = {
  seq: number;
  youtubeId: string;
  pos: number;
  dur: number;
};

const SAVE_EVERY_MS = 12_000;
const TICK_MS = 1000;

/**
 * Official YT.Player first. When the uploader disables embeds (101/150/153),
 * fall back to an Android-Innertube progressive MP4 proxied by our Worker so
 * playback stays inside OwnNote with real seek + progress.
 */
export function YouTubePlayer({ request, onState, onProgress, onTitle }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const readyRef = useRef(false);
  const seqRef = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  const titledRef = useRef<string | null>(null);
  const scrubbingRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<PlayRequest | null>(request);
  const wantPlayRef = useRef(false);
  const apiMissingRef = useRef(false);
  const modeRef = useRef<"youtube" | "direct">("youtube");
  const cb = useRef({ onState, onProgress, onTitle });
  cb.current = { onState, onProgress, onTitle };

  const [phase, setPhase] = useState<Phase>("idle");
  const [clock, setClock] = useState({ pos: 0, dur: 0 });
  const [blockReason, setBlockReason] = useState<string | null>(null);
  const [directSrc, setDirectSrc] = useState<string | null>(null);
  const [useDirect, setUseDirect] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const stopTick = useCallback(() => {
    clearInterval(tickRef.current);
    tickRef.current = undefined;
  }, []);

  const persistSession = useCallback((session: Session | null, keepalive = false) => {
    if (!session?.youtubeId) return;
    const pos = Math.floor(session.pos);
    const dur = Math.floor(session.dur);
    if (!pos && !dur) return;
    api
      .putWatch(
        session.youtubeId,
        { position_seconds: pos, ...(dur ? { duration_seconds: dur } : {}) },
        keepalive,
      )
      .catch(() => {});
  }, []);

  const flushSession = useCallback(
    (keepalive = false) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      persistSession(sessionRef.current, keepalive);
    },
    [persistSession],
  );

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) return;
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      persistSession(sessionRef.current);
    }, SAVE_EVERY_MS);
  }, [persistSession]);

  const readPlayer = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.seq !== seqRef.current || scrubbingRef.current) return;

    if (modeRef.current === "direct") {
      const v = videoRef.current;
      if (!v) return;
      const pos = Number(v.currentTime) || 0;
      const dur = Number(v.duration) || session.dur;
      if (!Number.isFinite(dur)) return;
      session.pos = pos;
      session.dur = dur;
      setClock({ pos, dur });
      cb.current.onProgress(session.youtubeId, pos, dur);
      return;
    }

    const p = playerRef.current;
    if (!p || typeof p.getCurrentTime !== "function") return;
    try {
      const pos = Number(p.getCurrentTime()) || 0;
      const dur = Number(p.getDuration()) || session.dur;
      session.pos = pos;
      session.dur = dur;
      setClock({ pos, dur });
      cb.current.onProgress(session.youtubeId, pos, dur);
    } catch {
      /* mid-swap */
    }
  }, []);

  const startTick = useCallback(() => {
    stopTick();
    tickRef.current = setInterval(() => {
      readPlayer();
      scheduleSave();
    }, TICK_MS);
  }, [readPlayer, scheduleSave, stopTick]);

  const isLive = useCallback((session: Session) => session.seq === seqRef.current, []);

  const beginSession = useCallback(
    (youtubeId: string, startSeconds: number): Session => {
      flushSession();
      stopTick();
      const seq = ++seqRef.current;
      const session: Session = {
        seq,
        youtubeId,
        pos: Math.max(0, startSeconds),
        dur: sessionRef.current?.youtubeId === youtubeId ? sessionRef.current.dur : 0,
      };
      sessionRef.current = session;
      titledRef.current = null;
      setBlockReason(null);
      setBanner(null);
      setClock({ pos: session.pos, dur: session.dur });
      cb.current.onProgress(youtubeId, session.pos, session.dur);
      return session;
    },
    [flushSession, stopTick],
  );

  const enterDirect = useCallback(
    async (session: Session, autoplay: boolean) => {
      if (!isLive(session)) return;
      modeRef.current = "direct";
      setUseDirect(true);
      setPhase("direct_loading");
      setDirectSrc(null);
      setBanner("Embed disabled — fetching an in-app stream…");
      try {
        playerRef.current?.stopVideo?.();
      } catch {
        /* ignore */
      }
      try {
        const media = await api.resolveMedia(session.youtubeId);
        if (!isLive(session)) return;
        if (media.title && titledRef.current !== session.youtubeId) {
          titledRef.current = session.youtubeId;
          cb.current.onTitle(session.youtubeId, media.title);
        }
        if (media.duration_seconds) {
          session.dur = media.duration_seconds;
          setClock({ pos: session.pos, dur: media.duration_seconds });
          cb.current.onProgress(session.youtubeId, session.pos, media.duration_seconds);
        }
        // Cache-bust so a new resolve after expiry remounts cleanly.
        setDirectSrc(`${media.src}?t=${media.expires_at}`);
        setPhase("direct");
        setBanner("Playing in-app (YouTube embed is disabled for this video).");
        wantPlayRef.current = autoplay;
      } catch (e) {
        if (!isLive(session)) return;
        modeRef.current = "youtube";
        setUseDirect(false);
        setDirectSrc(null);
        setPhase("blocked");
        setBanner(null);
        setBlockReason(
          e instanceof Error
            ? e.message
            : "Couldn't get an in-app stream. Open it on YouTube instead.",
        );
      }
    },
    [isLive],
  );

  const applyRequest = useCallback(
    (req: PlayRequest) => {
      const p = playerRef.current;
      if (!p || !readyRef.current) return;

      modeRef.current = "youtube";
      setUseDirect(false);
      setDirectSrc(null);
      const session = beginSession(req.youtubeId, req.startSeconds);
      wantPlayRef.current = req.play;
      setPhase("ready");

      const args = {
        videoId: req.youtubeId,
        startSeconds: Math.max(0, Math.floor(req.startSeconds)),
      };

      try {
        if (req.play) {
          p.loadVideoById(args);
          try {
            p.unMute?.();
            p.playVideo?.();
          } catch {
            /* poster */
          }
        } else {
          p.cueVideoById(args);
        }
      } catch {
        void enterDirect(session, req.play);
      }
    },
    [beginSession, enterDirect],
  );

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
            autoplay: 0,
            fs: 1,
          },
          events: {
            onReady: () => {
              readyRef.current = true;
              if (pendingRef.current) applyRequest(pendingRef.current);
            },
            onStateChange: (e: { data: number }) => {
              const session = sessionRef.current;
              if (!session || !isLive(session) || modeRef.current !== "youtube") return;
              const S = YT.PlayerState;
              if (e.data === S.PLAYING) {
                setPhase("playing");
                startTick();
                cb.current.onState(session.youtubeId, "playing");
              } else if (e.data === S.PAUSED) {
                setPhase("paused");
                stopTick();
                readPlayer();
                flushSession();
                cb.current.onState(session.youtubeId, "paused");
              } else if (e.data === S.ENDED) {
                setPhase("ended");
                stopTick();
                try {
                  const d = Number(playerRef.current?.getDuration?.()) || session.dur;
                  session.pos = d;
                  session.dur = d;
                  setClock({ pos: d, dur: d });
                  cb.current.onProgress(session.youtubeId, d, d);
                } catch {
                  /* ignore */
                }
                flushSession();
                cb.current.onState(session.youtubeId, "ended");
              } else if (e.data === S.CUED) {
                setPhase("ready");
                if (wantPlayRef.current) {
                  wantPlayRef.current = false;
                  try {
                    playerRef.current?.playVideo?.();
                  } catch {
                    /* poster */
                  }
                }
              } else if (e.data !== S.BUFFERING) {
                cb.current.onState(session.youtubeId, "other");
              }

              if ((e.data === S.CUED || e.data === S.PLAYING) && titledRef.current !== session.youtubeId) {
                const t = playerRef.current?.getVideoData?.()?.title;
                if (t) {
                  titledRef.current = session.youtubeId;
                  cb.current.onTitle(session.youtubeId, t);
                }
              }
            },
            onError: (e: { data: number }) => {
              const session = sessionRef.current;
              if (!session || !isLive(session)) return;
              stopTick();
              if (e.data === 101 || e.data === 150 || e.data === 153) {
                void enterDirect(session, true);
                return;
              }
              if (e.data === 100) {
                setPhase("blocked");
                setBlockReason("This video is unavailable.");
              } else if (e.data === 2) {
                setPhase("blocked");
                setBlockReason("Invalid video id.");
              } else {
                // Other embed failures — still try the in-app stream.
                void enterDirect(session, wantPlayRef.current);
              }
            },
            onAutoplayBlocked: () => {
              const session = sessionRef.current;
              if (!session || !isLive(session) || modeRef.current !== "youtube") return;
              setPhase("ready");
            },
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          apiMissingRef.current = true;
          setPhase("api_missing");
          setBlockReason("YouTube player failed to load in this browser.");
        }
      });

    const onHide = () => {
      if (document.visibilityState === "hidden") flushSession(true);
    };
    const onPageHide = () => flushSession(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      stopTick();
      flushSession();
      readyRef.current = false;
      try {
        playerRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      if (hostRef.current) hostRef.current.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    pendingRef.current = request;
    if (!request) {
      flushSession();
      seqRef.current++;
      sessionRef.current = null;
      stopTick();
      modeRef.current = "youtube";
      setUseDirect(false);
      setDirectSrc(null);
      setBanner(null);
      setPhase(apiMissingRef.current ? "api_missing" : "idle");
      setClock({ pos: 0, dur: 0 });
      setBlockReason(apiMissingRef.current ? "YouTube player failed to load in this browser." : null);
      try {
        playerRef.current?.stopVideo?.();
      } catch {
        /* ignore */
      }
      return;
    }
    if (apiMissingRef.current) {
      const session = beginSession(request.youtubeId, request.startSeconds);
      void enterDirect(session, request.play);
      return;
    }
    if (readyRef.current) applyRequest(request);
  }, [request, applyRequest, beginSession, enterDirect, flushSession, stopTick]);

  // When the direct <video> mounts / src changes, seek + optional autoplay.
  useEffect(() => {
    if (phase !== "direct" || !directSrc) return;
    const v = videoRef.current;
    const session = sessionRef.current;
    if (!v || !session) return;
    const onMeta = () => {
      if (!isLive(session)) return;
      if (session.pos > 0) {
        try {
          v.currentTime = session.pos;
        } catch {
          /* ignore */
        }
      }
      const dur = Number(v.duration) || session.dur;
      if (dur) {
        session.dur = dur;
        setClock({ pos: session.pos, dur });
        cb.current.onProgress(session.youtubeId, session.pos, dur);
      }
      if (wantPlayRef.current) {
        wantPlayRef.current = false;
        v.play().catch(() => setPhase("ready"));
      }
    };
    v.addEventListener("loadedmetadata", onMeta);
    if (v.readyState >= 1) onMeta();
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [phase, directSrc, isLive]);

  const playFromGesture = () => {
    const session = sessionRef.current;
    if (!session) return;
    if (modeRef.current === "direct") {
      videoRef.current?.play().catch(() => {});
      return;
    }
    try {
      playerRef.current?.unMute?.();
      playerRef.current?.playVideo?.();
    } catch {
      /* ignore */
    }
  };

  const togglePlay = () => {
    const session = sessionRef.current;
    if (!session) return;
    if (phase === "blocked" || phase === "direct_loading") return;
    if (modeRef.current === "direct") {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) v.play().catch(() => {});
      else v.pause();
      return;
    }
    const p = playerRef.current;
    if (!p) return;
    try {
      if (phase === "playing") p.pauseVideo();
      else {
        p.unMute?.();
        p.playVideo();
      }
    } catch {
      /* ignore */
    }
  };

  const seekBy = (delta: number) => {
    const session = sessionRef.current;
    if (!session || phase === "blocked" || phase === "direct_loading") return;
    if (modeRef.current === "direct") {
      const v = videoRef.current;
      if (!v) return;
      const dur = Number(v.duration) || session.dur;
      const next = Math.max(0, dur ? Math.min((v.currentTime || 0) + delta, Math.max(0, dur - 0.25)) : (v.currentTime || 0) + delta);
      v.currentTime = next;
      session.pos = next;
      session.dur = dur;
      setClock({ pos: next, dur });
      cb.current.onProgress(session.youtubeId, next, dur);
      scheduleSave();
      return;
    }
    const p = playerRef.current;
    if (!p) return;
    try {
      const cur = Number(p.getCurrentTime()) || session.pos;
      const dur = Number(p.getDuration()) || session.dur;
      const next = Math.max(0, dur ? Math.min(cur + delta, Math.max(0, dur - 0.25)) : cur + delta);
      p.seekTo(next, true);
      session.pos = next;
      session.dur = dur;
      setClock({ pos: next, dur });
      cb.current.onProgress(session.youtubeId, next, dur);
      scheduleSave();
    } catch {
      /* ignore */
    }
  };

  const onScrubInput = (e: ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.target.value);
    const session = sessionRef.current;
    if (!session) return;
    scrubbingRef.current = true;
    session.pos = next;
    setClock({ pos: next, dur: session.dur || clock.dur });
  };

  const commitScrub = () => {
    const session = sessionRef.current;
    scrubbingRef.current = false;
    if (!session) return;
    if (modeRef.current === "direct") {
      const v = videoRef.current;
      if (v) v.currentTime = session.pos;
    } else if (phase !== "blocked" && phase !== "api_missing" && phase !== "direct_loading") {
      try {
        playerRef.current?.seekTo(session.pos, true);
      } catch {
        /* ignore */
      }
    }
    cb.current.onProgress(session.youtubeId, session.pos, session.dur);
    flushSession();
  };

  const restart = () => {
    const session = sessionRef.current;
    if (!session) return;
    session.pos = 0;
    setClock({ pos: 0, dur: session.dur });
    if (modeRef.current === "direct") {
      const v = videoRef.current;
      if (v) {
        v.currentTime = 0;
        v.play().catch(() => {});
      }
      flushSession();
      return;
    }
    if (phase === "blocked" || phase === "api_missing") {
      flushSession();
      return;
    }
    try {
      playerRef.current?.seekTo(0, true);
      playerRef.current?.playVideo?.();
    } catch {
      /* ignore */
    }
    flushSession();
  };

  const id = request?.youtubeId ?? null;
  const pct = clock.dur > 0 ? (clock.pos / clock.dur) * 100 : 0;
  const showPoster =
    !!id && !useDirect && (phase === "ready" || phase === "ended");
  const showBlocked = !!id && (phase === "blocked" || (phase === "api_missing" && !useDirect));
  const controlsDisabled = !request || showBlocked || phase === "direct_loading";
  const watchHref = id
    ? `${youtubeWatchUrl(id)}${clock.pos > 0 ? `&t=${Math.floor(clock.pos)}s` : ""}`
    : "#";

  return (
    <div className="player-shell">
      <div className="player-frame" data-empty={!request} data-phase={phase}>
        <div
          ref={hostRef}
          className="player-host"
          data-active={request && !showBlocked && !useDirect ? true : undefined}
        />

        {useDirect && (
          <video
            ref={videoRef}
            className="player-direct"
            src={directSrc ?? undefined}
            playsInline
            preload="metadata"
            onPlay={() => {
              const session = sessionRef.current;
              if (!session || !isLive(session)) return;
              setPhase("playing");
              startTick();
              cb.current.onState(session.youtubeId, "playing");
            }}
            onPause={() => {
              const session = sessionRef.current;
              if (!session || !isLive(session)) return;
              setPhase("paused");
              stopTick();
              readPlayer();
              flushSession();
              cb.current.onState(session.youtubeId, "paused");
            }}
            onEnded={() => {
              const session = sessionRef.current;
              if (!session || !isLive(session)) return;
              setPhase("ended");
              stopTick();
              const d = session.dur || Number(videoRef.current?.duration) || session.pos;
              session.pos = d;
              session.dur = d;
              setClock({ pos: d, dur: d });
              cb.current.onProgress(session.youtubeId, d, d);
              flushSession();
              cb.current.onState(session.youtubeId, "ended");
            }}
            onError={() => {
              const session = sessionRef.current;
              if (!session || !isLive(session)) return;
              setPhase("blocked");
              setDirectSrc(null);
              setUseDirect(false);
              modeRef.current = "youtube";
              setBanner(null);
              setBlockReason("In-app stream failed. Open the video on YouTube instead.");
            }}
          />
        )}

        {phase === "direct_loading" && (
          <div className="player-loading" aria-live="polite">
            Fetching in-app stream…
          </div>
        )}

        {showPoster && (
          <button type="button" className="player-poster" onClick={playFromGesture} aria-label="Play video">
            <span
              className="player-poster-bg"
              style={{ "--poster": `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)` } as CSSProperties}
            />
            <span className="player-poster-disc" aria-hidden>
              <Play size={26} fill="currentColor" />
            </span>
          </button>
        )}

        {showBlocked && (
          <div className="player-blocked">
            <span
              className="player-poster-bg"
              style={{ "--poster": `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)` } as CSSProperties}
            />
            <div className="player-blocked-card">
              <p className="player-blocked-title">Can't play here</p>
              <p className="player-blocked-copy">{blockReason ?? "Open this video on YouTube instead."}</p>
              <a className="btn-primary" href={watchHref} target="_blank" rel="noreferrer">
                <ExternalLink size={15} />
                Watch on YouTube
                {clock.pos > 0 ? ` at ${formatClock(clock.pos)}` : ""}
              </a>
            </div>
          </div>
        )}

        {!request && <p className="player-hint">Paste a YouTube link below to start a queue.</p>}
      </div>

      {banner && (
        <p className="player-banner" role="status">
          {banner}
        </p>
      )}

      <div className="player-controls" data-disabled={controlsDisabled}>
        <button
          type="button"
          className="icon-btn"
          onClick={() => seekBy(-10)}
          disabled={controlsDisabled}
          aria-label="Back 10 seconds"
          title="-10s"
        >
          <SkipBack size={16} />
        </button>
        <button
          type="button"
          className="icon-btn solid"
          onClick={togglePlay}
          disabled={controlsDisabled}
          aria-label={phase === "playing" ? "Pause" : "Play"}
          title={phase === "playing" ? "Pause" : "Play"}
        >
          {phase === "playing" ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => seekBy(10)}
          disabled={controlsDisabled}
          aria-label="Forward 10 seconds"
          title="+10s"
        >
          <SkipForward size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={restart}
          disabled={!request || phase === "direct_loading"}
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
          onChange={onScrubInput}
          onPointerUp={commitScrub}
          onKeyUp={commitScrub}
          disabled={!request || phase === "direct_loading"}
          aria-label="Seek"
          style={{ "--pct": `${pct}%` } as CSSProperties}
        />
        <span className="player-clock">
          {request ? `${formatClock(clock.pos)} / ${formatClock(clock.dur)}` : "–:––"}
        </span>
        {id && (
          <a
            className="icon-btn"
            href={watchHref}
            target="_blank"
            rel="noreferrer"
            aria-label="Open on YouTube"
            title="Open on YouTube"
          >
            <ExternalLink size={15} />
          </a>
        )}
      </div>
    </div>
  );
}
