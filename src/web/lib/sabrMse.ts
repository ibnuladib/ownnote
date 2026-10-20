/** Play SABR fMP4 video+audio from a single framed mux stream into MediaSource. */

const APPEND_CHUNK = 256 * 1024;
const TYPE_END = 0;
const TYPE_VIDEO = 1;
const TYPE_AUDIO = 2;

function waitUpdateEnd(sb: SourceBuffer): Promise<void> {
  if (!sb.updating) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      sb.removeEventListener("updateend", done);
      resolve();
    };
    sb.addEventListener("updateend", done);
  });
}

async function appendBytes(
  sb: SourceBuffer,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength; offset += APPEND_CHUNK) {
    if (signal.aborted) return;
    const slice = bytes.subarray(offset, Math.min(offset + APPEND_CHUNK, bytes.byteLength));
    const copy = new Uint8Array(slice.byteLength);
    copy.set(slice);
    await waitUpdateEnd(sb);
    if (signal.aborted) return;
    sb.appendBuffer(copy);
  }
}

function sourceType(mime: string): string {
  if (mime.includes("codecs=")) return mime;
  if (mime.startsWith("video/")) return 'video/mp4; codecs="avc1.4d401f"';
  return 'audio/mp4; codecs="mp4a.40.2"';
}

class ByteReader {
  private pending = new Uint8Array(0);
  private done = false;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly signal: AbortSignal,
  ) {}

  private async fill(min: number): Promise<boolean> {
    while (this.pending.byteLength < min && !this.done) {
      if (this.signal.aborted) return false;
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      if (!value?.byteLength) continue;
      const next = new Uint8Array(this.pending.byteLength + value.byteLength);
      next.set(this.pending);
      next.set(value, this.pending.byteLength);
      this.pending = next;
    }
    return this.pending.byteLength >= min;
  }

  async readExact(n: number): Promise<Uint8Array | null> {
    if (!(await this.fill(n))) return null;
    const out = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n);
    return out;
  }
}

async function demuxMux(
  url: string,
  videoSb: SourceBuffer,
  audioSb: SourceBuffer,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok || !res.body) throw new Error(`SABR mux failed (${res.status})`);
  const br = new ByteReader(res.body.getReader(), signal);
  while (!signal.aborted) {
    const header = await br.readExact(5);
    if (!header) break;
    const type = header[0]!;
    const len = new DataView(header.buffer, header.byteOffset, 5).getUint32(1);
    if (type === TYPE_END) break;
    const payload = len > 0 ? await br.readExact(len) : new Uint8Array(0);
    if (!payload) break;
    if (type === TYPE_VIDEO) await appendBytes(videoSb, payload, signal);
    else if (type === TYPE_AUDIO) await appendBytes(audioSb, payload, signal);
  }
}

export type SabrMseHandle = {
  stop: () => void;
  whenReady: Promise<void>;
};

export function attachSabrMse(
  video: HTMLVideoElement,
  opts: {
    muxUrl: string;
    videoMime: string;
    audioMime: string;
  },
): SabrMseHandle {
  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  const ac = new AbortController();
  let stopped = false;

  const whenReady = new Promise<void>((resolve, reject) => {
    const onOpen = async () => {
      ms.removeEventListener("sourceopen", onOpen);
      try {
        const vType = sourceType(opts.videoMime);
        const aType = sourceType(opts.audioMime);
        if (!MediaSource.isTypeSupported(vType)) throw new Error(`MSE cannot play ${vType}`);
        if (!MediaSource.isTypeSupported(aType)) throw new Error(`MSE cannot play ${aType}`);
        const vSb = ms.addSourceBuffer(vType);
        const aSb = ms.addSourceBuffer(aType);
        vSb.mode = "segments";
        aSb.mode = "segments";
        const pump = demuxMux(opts.muxUrl, vSb, aSb, ac.signal).then(async () => {
          if (stopped || ac.signal.aborted) return;
          try {
            if (ms.readyState === "open") ms.endOfStream();
          } catch {
            /* ignore */
          }
        });
        pump.catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
        resolve();
        await pump;
      } catch (e) {
        reject(e);
      }
    };
    ms.addEventListener("sourceopen", onOpen);
  });

  video.removeAttribute("src");
  video.src = objectUrl;

  return {
    whenReady,
    stop: () => {
      stopped = true;
      ac.abort();
      try {
        if (ms.readyState === "open") ms.endOfStream();
      } catch {
        /* ignore */
      }
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(objectUrl);
    },
  };
}
