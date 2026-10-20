/**
 * Resolve streams for videos that disable YouTube embeds.
 * Progressive muxed MP4 (often 360p) + SABR adaptive (720p/1080p) via googlevideo.
 */

import { SabrStream } from "googlevideo/sabr-stream";
import type { SabrFormat } from "googlevideo/shared-types";

export type StreamQuality = {
  itag: number;
  label: string;
  height: number;
  mimeType: string;
  /** progressive = direct MP4 URL; sabr = adaptive via SABR session */
  kind: "progressive" | "sabr";
  upstreamUrl?: string;
  codecs?: string;
};

export type ResolvedCatalog = {
  youtubeId: string;
  title: string;
  durationSeconds: number;
  expiresAt: number;
  qualities: StreamQuality[];
  preferredItag: number;
  sabr?: {
    serverAbrStreamingUrl: string;
    videoPlaybackUstreamerConfig: string;
    formats: SabrFormat[];
    durationMs: number;
  };
};

export type ResolvedStream = {
  youtubeId: string;
  title: string;
  durationSeconds: number;
  mimeType: string;
  itag: number;
  label: string;
  height: number;
  kind: "progressive" | "sabr";
  upstreamUrl?: string;
  expiresAt: number;
};

type InnertubeFormat = {
  itag?: number;
  url?: string;
  mimeType?: string;
  quality?: string;
  qualityLabel?: string;
  height?: number;
  width?: number;
  fps?: number;
  bitrate?: number;
  averageBitrate?: number;
  contentLength?: string;
  approxDurationMs?: string;
  lastModified?: string;
  xtags?: string;
  audioQuality?: string;
};

type CacheEntry = { catalog: ResolvedCatalog; cachedAt: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

const ANDROID_VERSION = "21.03.36";
const ANDROID_UA =
  "com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip";

function codecsFromMime(mime?: string): string | undefined {
  const m = mime?.match(/codecs="([^"]+)"/);
  return m?.[1];
}

function labelFor(f: InnertubeFormat): string {
  if (f.qualityLabel) return f.qualityLabel;
  if (f.height) return `${f.height}p`;
  if (f.quality) return f.quality;
  return f.itag ? `itag ${f.itag}` : "auto";
}

function toSabrFormat(f: InnertubeFormat): SabrFormat | null {
  if (!f.itag || !f.bitrate) return null;
  return {
    itag: f.itag,
    lastModified: f.lastModified || "0",
    xtags: f.xtags || "",
    width: f.width,
    height: f.height,
    contentLength: f.contentLength ? Number(f.contentLength) : undefined,
    mimeType: f.mimeType,
    bitrate: f.bitrate,
    averageBitrate: f.averageBitrate,
    quality: f.quality,
    qualityLabel: f.qualityLabel,
    audioQuality: f.audioQuality,
    approxDurationMs: Number(f.approxDurationMs) || 0,
  };
}

function collectProgressive(formats: InnertubeFormat[]): StreamQuality[] {
  const out: StreamQuality[] = [];
  const seen = new Set<number>();
  for (const f of formats) {
    if (!f.url || !f.itag) continue;
    if (!f.mimeType?.includes("mp4")) continue;
    if (seen.has(f.itag)) continue;
    seen.add(f.itag);
    out.push({
      itag: f.itag,
      label: labelFor(f),
      height: f.height || 0,
      mimeType: f.mimeType.split(";")[0] || "video/mp4",
      kind: "progressive",
      upstreamUrl: f.url,
      codecs: codecsFromMime(f.mimeType),
    });
  }
  out.sort((a, b) => b.height - a.height || b.itag - a.itag);
  return out;
}

function collectSabrVideoQualities(adaptive: InnertubeFormat[]): StreamQuality[] {
  const byHeight = new Map<number, StreamQuality>();
  for (const f of adaptive) {
    if (!f.itag || !f.height || !f.mimeType?.includes("video/mp4")) continue;
    if (!f.mimeType.includes("avc1") && !f.mimeType.includes("avc")) {
      // Prefer H.264 for MSE; skip vp9/av1 if we already have avc for this height
      if (byHeight.has(f.height)) continue;
    }
    const existing = byHeight.get(f.height);
    const preferAvc = f.mimeType.includes("avc");
    if (existing && !preferAvc) continue;
    byHeight.set(f.height, {
      itag: f.itag,
      label: labelFor(f),
      height: f.height,
      mimeType: f.mimeType.split(";")[0] || "video/mp4",
      kind: "sabr",
      codecs: codecsFromMime(f.mimeType),
    });
  }
  return [...byHeight.values()].sort((a, b) => b.height - a.height);
}

function findDeep(obj: unknown, key: string, depth = 0): unknown {
  if (!obj || depth > 10 || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, key)) return rec[key];
  for (const v of Object.values(rec)) {
    const f = findDeep(v, key, depth + 1);
    if (f !== undefined) return f;
  }
  return undefined;
}

async function bootstrapCookies(): Promise<string> {
  try {
    const home = await fetch("https://www.youtube.com/", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      redirect: "follow",
    });
    const parts: string[] = [];
    const anyHeaders = home.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = anyHeaders.getSetCookie?.() ?? [];
    for (const c of setCookies) {
      const pair = c.split(";")[0];
      if (pair) parts.push(pair);
    }
    return parts.join("; ");
  } catch {
    return "";
  }
}

function expireFromUrl(url: string, fallback: number): number {
  try {
    const exp = Number(new URL(url).searchParams.get("expire"));
    if (exp > 1e9) return exp * 1000;
  } catch {
    /* keep fallback */
  }
  return fallback;
}

export async function resolveAndroidCatalog(youtubeId: string): Promise<ResolvedCatalog> {
  const hit = cache.get(youtubeId);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    if (hit.catalog.expiresAt - Date.now() > 5 * 60 * 1000) return hit.catalog;
  }

  const cookie = await bootstrapCookies();
  const body = {
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: ANDROID_VERSION,
        androidSdkVersion: 36,
        userAgent: ANDROID_UA,
        hl: "en",
        gl: "US",
        osName: "Android",
        osVersion: "16",
        platform: "MOBILE",
      },
    },
    videoId: youtubeId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" },
    },
  };

  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": ANDROID_UA,
      "X-YouTube-Client-Name": "3",
      "X-YouTube-Client-Version": ANDROID_VERSION,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`YouTube player lookup failed (${res.status})`);
  }

  const data = (await res.json()) as {
    playabilityStatus?: { status?: string; reason?: string };
    streamingData?: {
      formats?: InnertubeFormat[];
      adaptiveFormats?: InnertubeFormat[];
      serverAbrStreamingUrl?: string;
    };
    videoDetails?: { title?: string; lengthSeconds?: string };
    playerConfig?: unknown;
  };

  const status = data.playabilityStatus?.status;
  if (status && status !== "OK") {
    throw new Error(data.playabilityStatus?.reason || `Video is ${status}`);
  }

  const progressive = collectProgressive(data.streamingData?.formats ?? []);
  const adaptive = data.streamingData?.adaptiveFormats ?? [];
  const maxProg = progressive[0]?.height ?? 0;

  const ustreamer = findDeep(data, "videoPlaybackUstreamerConfig");
  const sabrUrl = data.streamingData?.serverAbrStreamingUrl;
  const sabrFormats = [...(data.streamingData?.formats ?? []), ...adaptive]
    .map(toSabrFormat)
    .filter((f): f is SabrFormat => !!f);
  const sabrReady =
    !!sabrUrl && typeof ustreamer === "string" && sabrFormats.length > 0;

  // Only advertise SABR ladder when googlevideo SABR can actually start.
  const sabrOnly = sabrReady
    ? collectSabrVideoQualities(adaptive).filter((q) => q.height > maxProg)
    : [];
  const qualities = [...sabrOnly, ...progressive];
  if (!qualities.length) {
    throw new Error("No stream available for this video");
  }

  const preferred =
    qualities.find((q) => q.height >= 720) ??
    qualities.find((q) => q.kind === "sabr") ??
    qualities[0]!;

  let expiresAt = Date.now() + CACHE_TTL_MS;
  for (const q of progressive) {
    if (q.upstreamUrl) expiresAt = Math.min(expiresAt, expireFromUrl(q.upstreamUrl, expiresAt));
  }

  const catalog: ResolvedCatalog = {
    youtubeId,
    title: data.videoDetails?.title?.trim() || "YouTube video",
    durationSeconds: Number(data.videoDetails?.lengthSeconds) || 0,
    expiresAt,
    qualities,
    preferredItag: preferred.itag,
    sabr: sabrReady
      ? {
          serverAbrStreamingUrl: sabrUrl!,
          videoPlaybackUstreamerConfig: ustreamer as string,
          formats: sabrFormats,
          durationMs: Number(data.videoDetails?.lengthSeconds || 0) * 1000,
        }
      : undefined,
  };
  cache.set(youtubeId, { catalog, cachedAt: Date.now() });
  return catalog;
}

export async function resolveAndroidStream(
  youtubeId: string,
  itag?: number,
): Promise<ResolvedStream> {
  const catalog = await resolveAndroidCatalog(youtubeId);
  const q =
    (itag ? catalog.qualities.find((x) => x.itag === itag) : undefined) ??
    catalog.qualities.find((x) => x.itag === catalog.preferredItag) ??
    catalog.qualities[0]!;
  return {
    youtubeId: catalog.youtubeId,
    title: catalog.title,
    durationSeconds: catalog.durationSeconds,
    mimeType: q.mimeType,
    itag: q.itag,
    label: q.label,
    height: q.height,
    kind: q.kind,
    upstreamUrl: q.upstreamUrl,
    expiresAt: catalog.expiresAt,
  };
}

/** Resolve SABR mime/label for a height without starting the googlevideo download. */
export async function peekSabrQualities(
  youtubeId: string,
  height: number,
): Promise<{ videoMime: string; audioMime: string; label: string }> {
  const catalog = await resolveAndroidCatalog(youtubeId);
  if (!catalog.sabr) throw new Error("SABR streaming is not available for this video");
  const qualityLabel = `${height}p`;
  const formats = catalog.sabr.formats;
  const video =
    formats.find(
      (f) =>
        f.qualityLabel === qualityLabel &&
        !!f.mimeType?.includes("video") &&
        (f.mimeType.includes("avc") || f.mimeType.includes("mp4")),
    ) ??
    formats.find((f) => f.height === height && !!f.mimeType?.includes("video")) ??
    formats.find((f) => !!f.mimeType?.includes("video") && (f.height ?? 0) >= height);
  const audio =
    formats.find((f) => f.audioQuality === "AUDIO_QUALITY_MEDIUM" && !!f.mimeType?.includes("audio")) ??
    formats.find((f) => !!f.mimeType?.includes("audio") && f.audioQuality) ??
    formats.find((f) => !!f.mimeType?.includes("audio"));
  if (!video || !audio) throw new Error("No SABR formats for that quality");
  return {
    videoMime: video.mimeType || "video/mp4",
    audioMime: audio.mimeType || "audio/mp4",
    label: video.qualityLabel || qualityLabel,
  };
}

export async function startSabrStreams(
  youtubeId: string,
  height: number,
): Promise<{
  videoStream: ReadableStream<Uint8Array>;
  audioStream: ReadableStream<Uint8Array>;
  videoMime: string;
  audioMime: string;
  videoItag: number;
  audioItag: number;
  label: string;
  abort: () => void;
}> {
  const catalog = await resolveAndroidCatalog(youtubeId);
  if (!catalog.sabr) throw new Error("SABR streaming is not available for this video");

  const sabr = new SabrStream({
    serverAbrStreamingUrl: catalog.sabr.serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig: catalog.sabr.videoPlaybackUstreamerConfig,
    formats: catalog.sabr.formats,
    durationMs: catalog.sabr.durationMs,
    clientInfo: {
      clientName: 3,
      clientVersion: ANDROID_VERSION,
    },
    // Workers require fetch to keep its receiver; bare `fetch` → Illegal invocation.
    fetch: (input, init) => globalThis.fetch(input, init),
  });

  const qualityLabel = `${height}p`;
  const { videoStream, audioStream, selectedFormats } = await sabr.start({
    videoQuality: qualityLabel,
    audioQuality: "medium",
    preferMP4: true,
    preferH264: true,
  });

  const vMime = selectedFormats.videoFormat.mimeType || "video/mp4";
  const aMime = selectedFormats.audioFormat.mimeType || "audio/mp4";
  return {
    videoStream,
    audioStream,
    videoMime: vMime,
    audioMime: aMime,
    videoItag: selectedFormats.videoFormat.itag,
    audioItag: selectedFormats.audioFormat.itag,
    label: selectedFormats.videoFormat.qualityLabel || qualityLabel,
    abort: () => sabr.abort(),
  };
}

/** Frame type bytes for the SABR mux stream (video / audio / end). */
export const SABR_MUX_VIDEO = 1;
export const SABR_MUX_AUDIO = 2;
export const SABR_MUX_END = 0;

/** Multiplex video+audio SABR tracks into one request-local byte stream. */
export function muxSabrTracks(
  videoStream: ReadableStream<Uint8Array>,
  audioStream: ReadableStream<Uint8Array>,
  abort: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Serialize frames so concurrent video/audio pumps never split a header.
      let gate = Promise.resolve();
      const send = (type: number, data: Uint8Array) => {
        gate = gate.then(() => {
          const header = new Uint8Array(5);
          header[0] = type;
          new DataView(header.buffer).setUint32(1, data.byteLength);
          controller.enqueue(header);
          if (data.byteLength) controller.enqueue(data);
        });
        return gate;
      };
      const pump = async (
        stream: ReadableStream<Uint8Array>,
        type: number,
      ): Promise<void> => {
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.byteLength) continue;
            await send(type, value);
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            /* ignore */
          }
        }
      };
      try {
        await Promise.all([
          pump(videoStream, SABR_MUX_VIDEO),
          pump(audioStream, SABR_MUX_AUDIO),
        ]);
        await send(SABR_MUX_END, new Uint8Array(0));
        controller.close();
      } catch (e) {
        try {
          controller.error(e);
        } catch {
          /* ignore */
        }
      } finally {
        try {
          abort();
        } catch {
          /* ignore */
        }
      }
    },
    cancel() {
      try {
        abort();
      } catch {
        /* ignore */
      }
    },
  });
}

export async function proxyUpstream(
  upstreamUrl: string,
  range: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {
    "User-Agent": ANDROID_UA,
    Accept: "*/*",
  };
  if (range) headers.Range = range;

  const upstream = await fetch(upstreamUrl, { headers, redirect: "follow" });
  if (!(upstream.ok || upstream.status === 206)) {
    return new Response(`Upstream media error (${upstream.status})`, { status: 502 });
  }

  const out = new Headers();
  const pass = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
  ] as const;
  for (const h of pass) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has("accept-ranges")) out.set("Accept-Ranges", "bytes");
  if (!out.has("content-type")) out.set("Content-Type", "video/mp4");
  out.set("Cache-Control", "private, max-age=3600");

  return new Response(upstream.body, { status: upstream.status, headers: out });
}
