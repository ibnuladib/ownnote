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
const sabr = data.streamingData?.serverAbrStreamingUrl;
console.log("sabr", sabr?.slice(0, 200));
const r = await fetch(sabr, {
  method: "GET",
  headers: { "User-Agent": ANDROID_UA, Range: "bytes=0-2000" },
  redirect: "follow",
});
console.log("fetch sabr", r.status, r.headers.get("content-type"), r.headers.get("content-length"));
const buf = new Uint8Array(await r.arrayBuffer());
console.log("bytes", buf.length, "head", [...buf.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" "));
