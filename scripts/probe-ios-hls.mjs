const key = "AIzaSyB-63vPrdThhKuerbB2N_c7KydVSYyE5kw";
const client = {
  clientName: "IOS",
  clientVersion: "19.45.4",
  deviceMake: "Apple",
  deviceModel: "iPhone16,2",
  userAgent: "com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)",
  osName: "iPhone",
  osVersion: "17.5.1.21F90",
  hl: "en",
  gl: "US",
};
const body = {
  context: { client },
  videoId: "9vM4p9NN0Ts",
  contentCheckOk: true,
  racyCheckOk: true,
};
const res = await fetch(
  `https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": client.userAgent,
      "X-YouTube-Client-Name": "5",
      "X-YouTube-Client-Version": client.clientVersion,
    },
    body: JSON.stringify(body),
  },
);
console.log("http", res.status);
const data = await res.json();
const sd = data.streamingData || {};
console.log("play", data.playabilityStatus?.status, data.error);
console.log("hls", sd.hlsManifestUrl?.slice?.(0, 150));
console.log(
  "prog",
  (sd.formats || []).map((f) => ({ i: f.itag, h: f.height, url: !!f.url })),
);
console.log(
  "adap urls",
  (sd.adaptiveFormats || []).filter((f) => f.url).map((f) => ({ i: f.itag, h: f.height })),
);
if (sd.hlsManifestUrl) {
  const h = await fetch(sd.hlsManifestUrl, { headers: { "User-Agent": client.userAgent } });
  const text = await h.text();
  console.log("m3u8", h.status, text.slice(0, 400));
}
