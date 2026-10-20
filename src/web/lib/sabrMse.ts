/** Play SABR fMP4 video+audio from a single framed mux stream into MediaSource. */

/** Coalesce googlevideo's tiny frames before each MSE append (avoids updateend thrash). */
const APPEND_TARGET = 512 * 1024;
const APPEND_MAX = 1024 * 1024;
const TYPE_END = 0;
const TYPE_VIDEO = 1;
const TYPE_AUDIO = 2;
/** Don't start playback until we have this much continuous media from t≈0. */
const READY_BUFFER_S = 1.0;
const READY_TIMEOUT_MS = 60_000;
/** Pause demux when ahead of playhead — keeps SourceBuffer from QuotaExceeded. */
const MAX_BUFFER_AHEAD_S = 40;
const MIN_BUFFER_AHEAD_S = 12;

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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("SABR aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("SABR aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function appendOnce(
  sb: SourceBuffer,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  // MSE requires a detached copy owned by us (stream buffers get reused).
  const copy =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.slice()
      : (() => {
          const c = new Uint8Array(bytes.byteLength);
          c.set(bytes);
          return c;
        })();

  for (let attempt = 0; attempt < 8; attempt++) {
    if (signal.aborted) return;
    await waitUpdateEnd(sb);
    if (signal.aborted) return;
    try {
      sb.appendBuffer(copy);
      await waitUpdateEnd(sb);
      return;
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      // QuotaExceeded: wait for playback to free space, then retry.
      if (name === "QuotaExceededError" || name === "InvalidStateError") {
        await sleep(250 + attempt * 100, signal);
        continue;
      }
      await waitUpdateEnd(sb);
      if (signal.aborted) return;
      try {
        sb.appendBuffer(copy);
        await waitUpdateEnd(sb);
        return;
      } catch {
        throw e;
      }
    }
  }
  throw new Error("SABR SourceBuffer append failed after retries");
}

type Pending = { chunks: Uint8Array[]; len: number; appended: number };

function pushPending(p: Pending, bytes: Uint8Array): void {
  if (!bytes.byteLength) return;
  p.chunks.push(bytes);
  p.len += bytes.byteLength;
}

async function flushPending(
  sb: SourceBuffer,
  p: Pending,
  signal: AbortSignal,
  force: boolean,
): Promise<void> {
  while (p.len > 0) {
    if (signal.aborted) return;
    // Append init + first media promptly; coalesce once we have a playable head.
    const target = p.appended < 256 * 1024 ? 32 * 1024 : APPEND_TARGET;
    if (!force && p.len < target) return;
    const take = force ? p.len : Math.min(p.len, APPEND_MAX);

    const chunks: Uint8Array[] = [];
    let got = 0;
    while (got < take && p.chunks.length) {
      const next = p.chunks[0]!;
      const need = take - got;
      if (next.byteLength <= need) {
        p.chunks.shift();
        chunks.push(next);
        got += next.byteLength;
      } else {
        chunks.push(next.subarray(0, need));
        p.chunks[0] = next.subarray(need);
        got += need;
      }
    }
    p.len -= got;
    p.appended += got;
    await appendOnce(sb, concatChunks(chunks, got), signal);
  }
}

function sourceType(mime: string): string {
  if (mime.includes("codecs=")) return mime;
  if (mime.startsWith("video/")) return 'video/mp4; codecs="avc1.4d401f"';
  return 'audio/mp4; codecs="mp4a.40.2"';
}

function sbBufferedEnd(sb: SourceBuffer): number {
  try {
    if (!sb.buffered.length) return 0;
    for (let i = 0; i < sb.buffered.length; i++) {
      const start = sb.buffered.start(i);
      const end = sb.buffered.end(i);
      if (start <= 0.5) return end;
    }
    return sb.buffered.end(0);
  } catch {
    return 0;
  }
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

/** Chunk-queue reader — avoids O(n²) realloc copies on every network read. */
class ByteReader {
  private chunks: Uint8Array[] = [];
  private total = 0;
  private offset = 0;
  private done = false;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly signal: AbortSignal,
  ) {}

  private available(): number {
    return this.total - this.offset;
  }

  private async fill(min: number): Promise<boolean> {
    while (this.available() < min && !this.done) {
      if (this.signal.aborted) return false;
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      if (!value?.byteLength) continue;
      this.chunks.push(value);
      this.total += value.byteLength;
    }
    return this.available() >= min;
  }

  async readExact(n: number): Promise<Uint8Array | null> {
    if (!(await this.fill(n))) return null;
    const first = this.chunks[0]!;
    if (first.byteLength - this.offset >= n) {
      const out = first.subarray(this.offset, this.offset + n);
      this.offset += n;
      if (this.offset >= first.byteLength) {
        this.chunks.shift();
        this.total -= first.byteLength;
        this.offset = 0;
      }
      return out;
    }
    const out = new Uint8Array(n);
    let wrote = 0;
    while (wrote < n) {
      const cur = this.chunks[0]!;
      const take = Math.min(n - wrote, cur.byteLength - this.offset);
      out.set(cur.subarray(this.offset, this.offset + take), wrote);
      wrote += take;
      this.offset += take;
      if (this.offset >= cur.byteLength) {
        this.chunks.shift();
        this.total -= cur.byteLength;
        this.offset = 0;
      }
    }
    return out;
  }
}

async function waitForBufferRoom(
  video: HTMLVideoElement,
  videoSb: SourceBuffer,
  audioSb: SourceBuffer,
  signal: AbortSignal,
): Promise<void> {
  const playhead0 = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const ahead0 = Math.min(sbBufferedEnd(videoSb), sbBufferedEnd(audioSb)) - playhead0;
  if (ahead0 < MAX_BUFFER_AHEAD_S) return;
  // Hysteresis: wait until buffer drains toward MIN before pumping again.
  while (!signal.aborted) {
    const playhead = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const ahead = Math.min(sbBufferedEnd(videoSb), sbBufferedEnd(audioSb)) - playhead;
    if (ahead < MIN_BUFFER_AHEAD_S) return;
    await sleep(200, signal);
  }
}

async function demuxMux(
  url: string,
  video: HTMLVideoElement,
  videoSb: SourceBuffer,
  audioSb: SourceBuffer,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin", signal });
  if (!res.ok || !res.body) throw new Error(`SABR mux failed (${res.status})`);
  const br = new ByteReader(res.body.getReader(), signal);
  const vPend: Pending = { chunks: [], len: 0, appended: 0 };
  const aPend: Pending = { chunks: [], len: 0, appended: 0 };

  while (!signal.aborted) {
    await waitForBufferRoom(video, videoSb, audioSb, signal);
    const header = await br.readExact(5);
    if (!header) break;
    const type = header[0]!;
    const len = new DataView(header.buffer, header.byteOffset, 5).getUint32(1);
    if (type === TYPE_END) break;
    const payload = len > 0 ? await br.readExact(len) : new Uint8Array(0);
    if (!payload) break;
    // Own the bytes — ByteReader may return a view into a reused network buffer.
    const owned = payload.slice();
    if (type === TYPE_VIDEO) {
      pushPending(vPend, owned);
      await flushPending(videoSb, vPend, signal, false);
    } else if (type === TYPE_AUDIO) {
      pushPending(aPend, owned);
      await flushPending(audioSb, aPend, signal, false);
    }
  }
  await flushPending(videoSb, vPend, signal, true);
  await flushPending(audioSb, aPend, signal, true);
}

export type SabrMseHandle = {
  stop: () => void;
  whenReady: Promise<void>;
};

function tracksReady(videoSb: SourceBuffer, audioSb: SourceBuffer): boolean {
  return sbBufferedEnd(videoSb) >= READY_BUFFER_S && sbBufferedEnd(audioSb) >= READY_BUFFER_S;
}

function waitForBuffer(
  video: HTMLVideoElement,
  videoSb: SourceBuffer,
  audioSb: SourceBuffer,
  signal: AbortSignal,
): Promise<void> {
  if (tracksReady(videoSb, audioSb)) return Promise.resolve();
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
      if (tracksReady(videoSb, audioSb)) finish(() => resolve());
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
    const poll = setInterval(onProgress, 150);
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

        const pump = demuxMux(opts.muxUrl, video, vSb, aSb, ac.signal).then(async () => {
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

        await waitForBuffer(video, vSb, aSb, ac.signal);
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
  video.preload = "auto";
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
