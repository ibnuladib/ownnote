const versions = ["19.35.36", "19.17.34", "19.02.39", "17.31.35", "21.03.36"];
const key = "AIzaSyA8eiZmMxxGPbVSRkW9JgajcJh5Ae5dKJc";
const vid = "9vM4p9NN0Ts";

for (const ver of versions) {
  const ua = `com.google.android.youtube/${ver} (Linux; U; Android 13; en_US) gzip`;
  const body = {
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: ver,
        androidSdkVersion: 33,
        userAgent: ua,
        hl: "en",
        gl: "US",
        osName: "Android",
        osVersion: "13",
        platform: "MOBILE",
      },
    },
    videoId: vid,
    contentCheckOk: true,
    racyCheckOk: true,
    params: "CgIQBg==",
    playbackContext: {
      contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" },
    },
  };
  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": ua,
        "X-YouTube-Client-Name": "3",
        "X-YouTube-Client-Version": ver,
      },
      body: JSON.stringify(body),
    },
  );
  const data = await res.json();
  const sd = data.streamingData || {};
  const prog = (sd.formats || [])
    .filter((f) => f.url)
    .map((f) => `${f.height}p/${f.itag}`);
  const adap = (sd.adaptiveFormats || []).filter((f) => f.url && f.height);
  const maxA = Math.max(0, ...adap.map((f) => f.height));
  console.log(
    ver,
    data.playabilityStatus?.status,
    "prog",
    prog.join(",") || "-",
    "adapUrls",
    adap.length,
    "maxAdap",
    maxA,
    "hls",
    !!sd.hlsManifestUrl,
  );
}
