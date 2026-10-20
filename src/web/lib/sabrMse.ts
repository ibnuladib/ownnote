/** Play SABR fMP4 video+audio from a single framed mux stream into MediaSource. */

const APPEND_CHUNK = 256 * 1024;
const TYPE_END = 0;
const TYPE_VIDEO = 1;
const TYPE_AUDIO = 2;
/** Resolve whenReady once we have this much continuous media from t=0. */
const READY_BUFFER_S = 0.35;
const READY_TIMEOUT_MS = 45_000;

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
    // Wait until idle, append, then wait for THIS append — browsers can report
    // updating===false in a gap before the previous append is fully booked.
    await waitUpdateEnd(sb);
    if (signal.aborted) return;
    try {
      sb.appendBuffer(copy);
    } catch {
      await waitUpdateEnd(sb);
      if (signal.aborted) return;
      sb.appendBuffer(copy);
    }
    await waitUpdateEnd(sb);
  }
}

function sourceType(mime: string): string {
  if (mime.includes("codecs=")) return mime;
  if (mime.startsWith("video/")) return 'video/mp4; codecs="avc1.4d401f"';
  return 'audio/mp4; codecs="mp4a.40.2"';
}

/** Earliest contiguous buffered end from t≈0, or 0 if nothing useful is buffered. */
export function sabrBufferedEnd(video: HTMLVideoElement): number {
  try {
    if (!video.buffered.length) return 0;
    // Prefer a range that covers (or starts near) the beginning.
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);
      if (start <= 0.5) return end;
    }
    return video.buffered.end(0);
  } catch {
    return 0;
  }
}

/** Clamp a seek target into currently buffered media (SABR has no mid-stream jump yet). */
export function clampSabrSeek(video: HTMLVideoElement, want: number): number {
  try {
    if (!video.buffered.length) return 0;
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);
      if (want >= start && want <= end - 0.15) return want;
    }
    // Nearest buffered end, slightly inside the range.
    let best = video.buffered.start(0);
    let bestDist = Infinity;
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);
      const clamped = Math.min(Math.max(want, start), Math.max(start, end - 0.25));
      const dist = Math.abs(clamped - want);
      if (dist < bestDist) {
        bestDist = dist;
        best = clamped;
      }
    }
    return best;
  } catch {
    return 0;
  }
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

function waitForBuffer(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  if (sabrBufferedEnd(video) >= READY_BUFFER_S) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      video.removeEventListener("progress", onProgress);
      video.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onProgress = () => {
      if (sabrBufferedEnd(video) >= READY_BUFFER_S) finish(() => resolve());
    };
    const onError = () =>
      finish(() => reject(new Error(video.error?.message || "SABR media error")));
    const onAbort = () => finish(() => reject(new Error("SABR aborted")));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Error("SABR stream stalled before any playable media buffered")),
        ),
      READY_TIMEOUT_MS,
    );
    // Poll too — MSE progress events are unreliable across browsers.
    const poll = setInterval(onProgress, 200);
    video.addEventListener("progress", onProgress);
    video.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort);
  });
}

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
    let settled = false;
    const ok = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      reject(e instanceof Error ? e : new Error(String(e)));
    };
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

        const sbError = (which: string) => () => fail(new Error(`SABR ${which} SourceBuffer error`));
        vSb.addEventListener("error", sbError("video"));
        aSb.addEventListener("error", sbError("audio"));

        const pump = demuxMux(opts.muxUrl, vSb, aSb, ac.signal).then(async () => {
          if (stopped || ac.signal.aborted) return;
          try {
            if (ms.readyState === "open") ms.endOfStream();
          } catch {
            /* ignore */
          }
        });
        pump.catch((e) => {
          if (!stopped && !ac.signal.aborted) fail(e);
        });

        await waitForBuffer(video, ac.signal);
        if (stopped || ac.signal.aborted) {
          fail(new Error("SABR aborted"));
          return;
        }
        ok();
        await pump;
      } catch (e) {
        fail(e);
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
