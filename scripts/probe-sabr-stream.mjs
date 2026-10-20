import { SabrStream } from "googlevideo/sabr-stream";

const ANDROID_VERSION = "21.03.36";
const ANDROID_UA =
  "com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip";

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
  videoId: "9vM4p9NN0Ts",
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
const data = await res.json();
const sd = data.streamingData;
console.log("ustreamer", !!data.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig);
console.log("keys playerConfig", JSON.stringify(data.playerConfig).slice(0, 300));

const ustreamer =
  data.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig ||
  data.videoDetails?.videoPlaybackUstreamerConfig;

// Find ustreamer in response
function findKey(obj, key, depth = 0) {
  if (!obj || depth > 8 || typeof obj !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const f = findKey(v, key, depth + 1);
    if (f) return f;
  }
  return null;
}
const config = findKey(data, "videoPlaybackUstreamerConfig");
console.log("found config", typeof config, String(config).slice(0, 80));

const formats = [...(sd.formats || []), ...(sd.adaptiveFormats || [])].map((f) => ({
  itag: f.itag,
  lastModified: f.lastModified,
  xtags: f.xtags || "",
  width: f.width,
  height: f.height,
  fps: f.fps,
  qualityLabel: f.qualityLabel,
  audioQuality: f.audioQuality,
  mimeType: f.mimeType,
  bitrate: f.bitrate,
  averageBitrate: f.averageBitrate,
  contentLength: f.contentLength,
  approxDurationMs: f.approxDurationMs,
}));

const sabr = new SabrStream({
  serverAbrStreamingUrl: sd.serverAbrStreamingUrl,
  videoPlaybackUstreamerConfig: config,
  formats,
  clientInfo: {
    clientName: 3,
    clientVersion: ANDROID_VERSION,
  },
  durationMs: Number(data.videoDetails?.lengthSeconds || 0) * 1000,
});

try {
  const { videoStream, audioStream } = await sabr.start({
    videoQuality: "720p",
    audioQuality: "medium",
    preferMP4: true,
    preferH264: true,
  });
  console.log("started streams", !!videoStream, !!audioStream);
  const reader = videoStream.getReader();
  let total = 0;
  for (let i = 0; i < 5; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    console.log("chunk", i, value.byteLength, "total", total, "head", [...value.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  }
  sabr.abort();
} catch (e) {
  console.error("sabr start failed", e);
}
