const vid = "9vM4p9NN0Ts";
const res = await fetch(`https://www.youtube.com/watch?v=${vid}&bpctr=9999999999&has_verified=1`, {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
  },
});
const html = await res.text();
console.log("html", res.status, html.length);
const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
if (!m) {
  console.log("no player response", html.includes("ytInitialPlayerResponse"));
  process.exit(0);
}
const data = JSON.parse(m[1]);
const sd = data.streamingData || {};
console.log("status", data.playabilityStatus?.status);
console.log(
  "prog",
  (sd.formats || []).map((f) => ({
    itag: f.itag,
    h: f.height,
    url: !!f.url,
    cipher: !!(f.signatureCipher || f.cipher),
  })),
);
const adap = sd.adaptiveFormats || [];
console.log(
  "adap sample",
  adap
    .filter((f) => (f.height || 0) >= 720 || f.audioQuality)
    .slice(0, 8)
    .map((f) => ({
      itag: f.itag,
      h: f.height,
      aq: f.audioQuality,
      url: !!f.url,
      cipher: !!(f.signatureCipher || f.cipher),
    })),
);
console.log("hls", !!sd.hlsManifestUrl, "dash", !!sd.dashManifestUrl);
