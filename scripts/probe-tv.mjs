const clients = [
  {
    label: "TV",
    cn: "7",
    key: "AIzaSyDCU8hBzN1-B3Y5oUKqQqQqQqQqQqQqQqQ", // placeholder - use real
    client: {
      clientName: "TVHTML5",
      clientVersion: "7.20250312.16.00",
      hl: "en",
      gl: "US",
    },
    ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
  },
];

// Real keys from public yt-dlp
const REAL = [
  {
    label: "TVHTML5",
    cn: "7",
    key: "AIzaSyDCU8hBy9K96rW2sSNb6o_z-PnIhYzB-fA", // may be wrong
    client: {
      clientName: "TVHTML5",
      clientVersion: "7.20241009.17.00",
      hl: "en",
      gl: "US",
    },
    ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
  },
  {
    label: "TVHTML5_SIMPLY",
    cn: "75",
    key: "AIzaSyA8eiZmMxxGPbVSRkW9JgajcJh5Ae5dKJc",
    client: {
      clientName: "TVHTML5_SIMPLY",
      clientVersion: "1.0",
      hl: "en",
      gl: "US",
    },
    ua: "Mozilla/5.0",
  },
  {
    label: "WEB_EMBEDDED",
    cn: "56",
    key: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
    client: {
      clientName: "WEB_EMBEDDED_PLAYER",
      clientVersion: "1.20241001.00.00",
      clientScreen: "EMBED",
      hl: "en",
      gl: "US",
    },
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    thirdParty: { embedUrl: "https://www.youtube.com/" },
  },
];

for (const c of REAL) {
  const body = {
    context: {
      client: c.client,
      ...(c.thirdParty ? { thirdParty: c.thirdParty } : {}),
    },
    videoId: "9vM4p9NN0Ts",
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const url = `https://www.youtube.com/youtubei/v1/player?key=${c.key}&prettyPrint=false`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": c.ua,
      "X-YouTube-Client-Name": c.cn,
      "X-YouTube-Client-Version": c.client.clientVersion,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const sd = data.streamingData || {};
  const prog = (sd.formats || []).filter((f) => f.url).map((f) => `${f.height}p`);
  const adap = (sd.adaptiveFormats || []).filter((f) => f.url && f.height);
  console.log(
    c.label,
    data.playabilityStatus?.status || data.error?.message || "?",
    "prog",
    prog.join(",") || "-",
    "adapUrls",
    adap.length,
    "max",
    Math.max(0, ...adap.map((f) => f.height)),
    "hls",
    !!sd.hlsManifestUrl,
  );
}
