/**
 * Offline catalog check for fixture 9vM4p9NN0Ts — mirrors resolveAndroidCatalog
 * preference rules without needing worker auth.
 */
const VIDEO_ID = process.argv[2] || "9vM4p9NN0Ts";
const ANDROID_VERSION = "21.03.36";
const ANDROID_UA =
  "com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip";

function findDeep(obj, key, depth = 0) {
  if (!obj || depth > 10 || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const f = findDeep(v, key, depth + 1);
    if (f !== undefined) return f;
  }
  return undefined;
}

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
  videoId: VIDEO_ID,
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
  },
  body: JSON.stringify(body),
});
if (!res.ok) {
  console.error("player failed", res.status);
  process.exit(1);
}
const data = await res.json();
const progressive = (data.streamingData?.formats || [])
  .filter((f) => f.url && f.itag && f.mimeType?.includes("mp4"))
  .map((f) => ({
    itag: f.itag,
    height: f.height || 0,
    label: f.qualityLabel || `${f.height}p`,
    kind: "progressive",
  }))
  .sort((a, b) => b.height - a.height);

const maxProg = progressive[0]?.height ?? 0;
const ustreamer = findDeep(data, "videoPlaybackUstreamerConfig");
const sabrUrl = data.streamingData?.serverAbrStreamingUrl;
const adaptive = data.streamingData?.adaptiveFormats || [];
const sabrReady = !!sabrUrl && typeof ustreamer === "string";

const byHeight = new Map();
for (const f of adaptive) {
  if (!f.itag || !f.height || !f.mimeType?.includes("video/mp4")) continue;
  const preferAvc = f.mimeType.includes("avc");
  const existing = byHeight.get(f.height);
  if (existing && !preferAvc) continue;
  if (!preferAvc && byHeight.has(f.height)) continue;
  byHeight.set(f.height, {
    itag: f.itag,
    height: f.height,
    label: f.qualityLabel || `${f.height}p`,
    kind: "sabr",
  });
}
const sabrOnly = sabrReady
  ? [...byHeight.values()].filter((q) => q.height > maxProg).sort((a, b) => b.height - a.height)
  : [];
const qualities = [...sabrOnly, ...progressive];
// Prefer progressive for instant start; SABR ≤720p stays in the ladder.
const sabrQs = qualities.filter((q) => q.kind === "sabr");
const preferred =
  qualities.find((q) => q.kind === "progressive") ??
  sabrQs.find((q) => q.height === 720) ??
  sabrQs
    .filter((q) => q.height > 0 && q.height <= 720)
    .sort((a, b) => b.height - a.height)[0] ??
  sabrQs[0] ??
  qualities[0];

console.log(
  JSON.stringify(
    {
      videoId: VIDEO_ID,
      sabrReady,
      maxProg,
      preferred,
      qualities,
      has720plus: qualities.some((q) => q.height >= 720),
    },
    null,
    2,
  ),
);

if (!preferred || preferred.kind !== "progressive") {
  console.error("FAIL: preferred is not progressive (fast-start default)");
  process.exit(2);
}
if (!sabrQs.some((q) => q.height === 720)) {
  console.error("FAIL: 720p SABR missing from ladder");
  process.exit(2);
}
console.error("OK: preferred progressive; 720p SABR in ladder");
