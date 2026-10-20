/**
 * Resolve a progressive MP4 for videos that disable YouTube embeds.
 * Uses the Android Innertube client (same path as youtubei.js), then we
 * proxy the googlevideo URL so the browser IP matches the URL's IP lock.
 */

export type ResolvedStream = {
  youtubeId: string;
  title: string;
  durationSeconds: number;
  mimeType: string;
  /** Upstream googlevideo URL — only fetch this from the Worker. */
  upstreamUrl: string;
  expiresAt: number;
};

const ANDROID_VERSION = "21.03.36";
const ANDROID_UA =
  "com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip";

type CacheEntry = { stream: ResolvedStream; cachedAt: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

function pickProgressive(data: {
  streamingData?: {
    formats?: Array<{ url?: string; mimeType?: string; quality?: string; contentLength?: string }>;
  };
  videoDetails?: { title?: string; lengthSeconds?: string };
}): Omit<ResolvedStream, "youtubeId" | "expiresAt"> | null {
  const formats = data.streamingData?.formats ?? [];
  const progressive =
    formats.find((f) => f.url && f.mimeType?.includes("mp4") && f.mimeType.includes("avc1")) ??
    formats.find((f) => f.url && f.mimeType?.includes("mp4")) ??
    formats.find((f) => f.url);
  if (!progressive?.url) return null;
  return {
    title: data.videoDetails?.title?.trim() || "YouTube video",
    durationSeconds: Number(data.videoDetails?.lengthSeconds) || 0,
    mimeType: progressive.mimeType?.split(";")[0] || "video/mp4",
    upstreamUrl: progressive.url,
  };
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

export async function resolveAndroidStream(youtubeId: string): Promise<ResolvedStream> {
  const hit = cache.get(youtubeId);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    // Refresh a bit before expiry (~5h typical); keep using while fresh.
    if (hit.stream.expiresAt - Date.now() > 5 * 60 * 1000) return hit.stream;
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
      formats?: Array<{ url?: string; mimeType?: string; quality?: string }>;
    };
    videoDetails?: { title?: string; lengthSeconds?: string };
  };

  const status = data.playabilityStatus?.status;
  if (status && status !== "OK") {
    throw new Error(data.playabilityStatus?.reason || `Video is ${status}`);
  }

  const picked = pickProgressive(data);
  if (!picked) {
    throw new Error("No progressive stream available for this video");
  }

  // googlevideo URLs typically carry expire= unix seconds
  let expiresAt = Date.now() + CACHE_TTL_MS;
  try {
    const u = new URL(picked.upstreamUrl);
    const exp = Number(u.searchParams.get("expire"));
    if (exp > 1e9) expiresAt = exp * 1000;
  } catch {
    /* keep default */
  }

  const stream: ResolvedStream = { youtubeId, expiresAt, ...picked };
  cache.set(youtubeId, { stream, cachedAt: Date.now() });
  return stream;
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
