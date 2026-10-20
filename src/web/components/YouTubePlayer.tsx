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
  Maximize,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { youtubeWatchUrl } from "@shared/youtube";
import { api } from "../api";
import {
  attachSabrMse,
  clampSabrSeek,
  sabrBufferedEnd,
  type SabrMseHandle,
} from "../lib/sabrMse";
import { formatClock } from "../lib/time";

type QualityOption = {
  id: string;
  label: string;
  src?: string;
  kind: "progressive" | "sabr" | "youtube";
  height?: number;
};

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

const YT_QUALITY_LABEL: Record<string, string> = {
  highres: "High res",
  hd2160: "2160p",
  hd1440: "1440p",
  hd1080: "1080p",
  hd720: "720p",
  large: "480p",
  medium: "360p",
  small: "240p",
  tiny: "144p",
  auto: "Auto",
  default: "Auto",
};

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
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [qualities, setQualities] = useState<QualityOption[]>([]);
  const [qualityId, setQualityId] = useState<string>("");
  const frameRef = useRef<HTMLDivElement>(null);
  const sabrRef = useRef<SabrMseHandle | null>(null);
  const sabrSessionRef = useRef<{ youtubeId: string; sessionId: string } | null>(null);

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

  const stopSabr = useCallback(() => {
    sabrRef.current?.stop();
    sabrRef.current = null;
    const sid = sabrSessionRef.current;
    sabrSessionRef.current = null;
    if (sid) api.endSabr(sid.youtubeId, sid.sessionId).catch(() => {});
  }, []);

  const beginSession = useCallback(
    (youtubeId: string, startSeconds: number): Session => {
      flushSession();
      stopTick();
      stopSabr();
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
      setQualities([]);
      setQualityId("");
      setSpeed(1);
      setClock({ pos: session.pos, dur: session.dur });
      cb.current.onProgress(youtubeId, session.pos, session.dur);
      return session;
    },
    [flushSession, stopSabr, stopTick],
  );

  const playSabrQuality = useCallback(
    async (session: Session, height: number, autoplay: boolean) => {
      stopSabr();
      setDirectSrc(null);
      setUseDirect(true);
      setPhase("direct_loading");
      setBanner(`Starting ${height}p in-app stream…`);
      const started = await api.startSabr(session.youtubeId, height);
      if (!isLive(session)) {
        api.endSabr(session.youtubeId, started.sessionId).catch(() => {});
        return;
      }
      // Wait for React to mount <video> (useDirect=true, no progressive src).
      let v = videoRef.current;
      for (let i = 0; i < 30 && !v; i++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        v = videoRef.current;
      }
      if (!v) throw new Error("Video element missing");
      sabrSessionRef.current = { youtubeId: session.youtubeId, sessionId: started.sessionId };
      const handle = attachSabrMse(v, {
        muxUrl: started.muxUrl,
        videoMime: started.videoMime,
        audioMime: started.audioMime,
      });
      sabrRef.current = handle;
      await handle.whenReady;
      if (!isLive(session)) {
        handle.stop();
        return;
      }
      // SABR mux always starts at t=0. Seeking past the buffered prefix stalls
      // forever while the UI still said "Playing" — that was the silent failure.
      const buffered = sabrBufferedEnd(v);
      const resumeFrom = session.pos;
      if (resumeFrom > 1 && resumeFrom > buffered - 0.5) {
        session.pos = 0;
        setClock({ pos: 0, dur: session.dur });
        setBanner(
          `Playing ${started.label} in-app from the start (can't resume at ${formatClock(resumeFrom)} yet).`,
        );
      } else if (resumeFrom > 0 && buffered > resumeFrom) {
        try {
          v.currentTime = clampSabrSeek(v, resumeFrom);
        } catch {
          /* ignore */
        }
        setBanner(`Playing ${started.label} in-app (YouTube embed is disabled).`);
      } else {
        setBanner(`Playing ${started.label} in-app (YouTube embed is disabled).`);
      }
      setPhase("direct");
      wantPlayRef.current = autoplay;
      if (autoplay) {
        try {
          await v.play();
        } catch {
          setBanner(`Ready — ${started.label} buffered. Press play to start.`);
          setPhase("ready");
        }
      }
    },
    [isLive, stopSabr],
  );

  const enterDirect = useCallback(
    async (session: Session, autoplay: boolean) => {
      if (!isLive(session)) return;
      modeRef.current = "direct";
      setUseDirect(true);
      setPhase("direct_loading");
      setDirectSrc(null);
      setQualities([]);
      stopSabr();
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
        const qs: QualityOption[] = (media.qualities ?? []).map((q) => {
          const raw = typeof q.src === "string" && q.src.startsWith("/") ? q.src : null;
          return {
            id: `${q.kind}-${q.itag}`,
            label: q.label,
            src: raw
              ? `${raw}${raw.includes("?") ? "&" : "?"}t=${media.expires_at}`
              : undefined,
            kind: q.kind,
            height: q.height,
          };
        });
        setQualities(qs);
        const preferred =
          qs.find((q) => q.id === `${media.kind}-${media.itag}`) ??
          qs.find((q) => (q.height ?? 0) >= 720) ??
          qs[0];
        if (!preferred) throw new Error("No playable qualities");
        setQualityId(preferred.id);
        if (preferred.kind === "sabr") {
          try {
            await playSabrQuality(session, preferred.height || 720, autoplay);
          } catch (sabrErr) {
            // Fall back to progressive (≈360p) so something still plays.
            const progressive = qs.find((q) => q.kind === "progressive" && q.src);
            if (!progressive?.src) throw sabrErr;
            stopSabr();
            setQualityId(progressive.id);
            setDirectSrc(progressive.src);
            setPhase("direct");
            console.warn("SABR playback failed, falling back to progressive", sabrErr);
            setBanner(
              `HD stream unavailable — playing ${progressive.label} instead.`,
            );
            wantPlayRef.current = autoplay;
          }
        } else if (preferred.src) {
          setDirectSrc(preferred.src);
          setPhase("direct");
          setBanner("Playing in-app (YouTube embed is disabled for this video).");
          wantPlayRef.current = autoplay;
        } else {
          throw new Error("No playable stream URL for that quality");
        }
      } catch (e) {
        if (!isLive(session)) return;
        modeRef.current = "youtube";
        setUseDirect(false);
        setDirectSrc(null);
        setQualities([]);
        stopSabr();
        setPhase("blocked");
        setBanner(null);
        setBlockReason(
          e instanceof Error
            ? e.message
            : "Couldn't get an in-app stream. Open it on YouTube instead.",
        );
      }
    },
    [isLive, playSabrQuality, stopSabr],
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
                try {
                  const levels: string[] = playerRef.current?.getAvailableQualityLevels?.() ?? [];
                  if (levels.length) {
                    setQualities(
                      levels.map((qid) => ({
                        id: qid,
                        label: YT_QUALITY_LABEL[qid] ?? qid,
                        kind: "youtube" as const,
                      })),
                    );
                    const cur = playerRef.current?.getPlaybackQuality?.() as string | undefined;
                    if (cur) setQualityId(cur);
                  }
                } catch {
                  /* ignore */
                }
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
      let next = Math.max(0, dur ? Math.min((v.currentTime || 0) + delta, Math.max(0, dur - 0.25)) : (v.currentTime || 0) + delta);
      // SABR only has a live buffered prefix — don't seek into empty media.
      if (sabrRef.current) next = clampSabrSeek(v, next);
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
      if (v) {
        const target = sabrRef.current ? clampSabrSeek(v, session.pos) : session.pos;
        session.pos = target;
        v.currentTime = target;
        setClock({ pos: target, dur: session.dur });
      }
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

  const toggleMute = () => {
    if (modeRef.current === "direct") {
      const v = videoRef.current;
      if (!v) return;
      v.muted = !v.muted;
      setMuted(v.muted);
      return;
    }
    try {
      const p = playerRef.current;
      if (!p) return;
      if (p.isMuted?.()) {
        p.unMute?.();
        setMuted(false);
      } else {
        p.mute?.();
        setMuted(true);
      }
    } catch {
      /* ignore */
    }
  };

  const onVolumeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.target.value);
    setVolume(next);
    setMuted(next === 0);
    if (modeRef.current === "direct") {
      const v = videoRef.current;
      if (!v) return;
      v.volume = next;
      v.muted = next === 0;
      return;
    }
    try {
      playerRef.current?.setVolume?.(Math.round(next * 100));
      if (next === 0) playerRef.current?.mute?.();
      else playerRef.current?.unMute?.();
    } catch {
      /* ignore */
    }
  };

  const onSpeedChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = Number(e.target.value);
    setSpeed(next);
    if (modeRef.current === "direct") {
      const v = videoRef.current;
      if (v) v.playbackRate = next;
      return;
    }
    try {
      playerRef.current?.setPlaybackRate?.(next);
    } catch {
      /* ignore */
    }
  };

  const onQualityChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    setQualityId(next);
    if (modeRef.current === "direct") {
      const q = qualities.find((x) => x.id === next);
      const session = sessionRef.current;
      if (!q || !session) return;
      const wasPlaying = phase === "playing" || wantPlayRef.current;
      if (q.kind === "sabr") {
        void playSabrQuality(session, q.height || 720, wasPlaying).catch((err) => {
          setBanner(err instanceof Error ? err.message : "Couldn't switch quality");
        });
        return;
      }
      if (!q.src) return;
      stopSabr();
      session.pos = videoRef.current?.currentTime || session.pos;
      setDirectSrc(q.src);
      wantPlayRef.current = wasPlaying;
      return;
    }
    try {
      playerRef.current?.setPlaybackQuality?.(next);
      playerRef.current?.setPlaybackQualityRange?.(next, next);
    } catch {
      /* ignore */
    }
  };

  const toggleFullscreen = () => {
    const el = frameRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
      return;
    }
    void el.requestFullscreen?.();
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
      <div ref={frameRef} className="player-frame" data-empty={!request} data-phase={phase}>
        <div
          ref={hostRef}
          className="player-host"
          data-active={request && !showBlocked && !useDirect ? true : undefined}
        />

        {useDirect && (
          <video
            key={directSrc ?? `sabr-${qualityId}`}
            ref={videoRef}
            className="player-direct"
            {...(directSrc ? { src: directSrc } : {})}
            playsInline
            preload="metadata"
            onLoadedMetadata={() => {
              const v = videoRef.current;
              const session = sessionRef.current;
              if (!v || !session || !directSrc) return;
              if (session.pos > 0 && Math.abs(v.currentTime - session.pos) > 0.5) {
                v.currentTime = session.pos;
              }
              v.playbackRate = speed;
              v.volume = volume;
              v.muted = muted;
              if (wantPlayRef.current) {
                wantPlayRef.current = false;
                v.play().catch(() => {});
              }
            }}
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
              // SABR MSE errors are handled by attachSabrMse; progressive failures land here.
              if (!directSrc) return;
              setPhase("blocked");
              setDirectSrc(null);
              setUseDirect(false);
              stopSabr();
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
        <div className="player-transport">
          <button
            type="button"
            className="icon-btn skip-btn"
            onClick={() => seekBy(-5)}
            disabled={controlsDisabled}
            aria-label="Back 5 seconds"
            title="-5s"
          >
            −5
          </button>
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
            className="icon-btn skip-btn"
            onClick={() => seekBy(5)}
            disabled={controlsDisabled}
            aria-label="Forward 5 seconds"
            title="+5s"
          >
            +5
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
        </div>

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

        <div className="player-extras">
          <button
            type="button"
            className="icon-btn"
            onClick={toggleMute}
            disabled={controlsDisabled}
            aria-label={muted ? "Unmute" : "Mute"}
            title={muted ? "Unmute" : "Mute"}
          >
            {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <input
            className="player-volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={onVolumeChange}
            disabled={controlsDisabled}
            aria-label="Volume"
          />
          <label className="player-select-wrap">
            <span className="sr-only">Speed</span>
            <select
              className="player-select"
              value={speed}
              onChange={onSpeedChange}
              disabled={controlsDisabled}
              title="Playback speed"
              aria-label="Playback speed"
            >
              {SPEED_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s === 1 ? "1×" : `${s}×`}
                </option>
              ))}
            </select>
          </label>
          {qualities.length > 0 && (
            <label className="player-select-wrap">
              <span className="sr-only">Quality</span>
              <select
                className="player-select"
                value={qualityId}
                onChange={onQualityChange}
                disabled={controlsDisabled}
                title="Quality"
                aria-label="Quality"
              >
                {qualities.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="icon-btn"
            onClick={toggleFullscreen}
            disabled={!request}
            aria-label="Fullscreen"
            title="Fullscreen"
          >
            <Maximize size={15} />
          </button>
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
    </div>
  );
}
