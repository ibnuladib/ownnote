/** Normalize D1 BLOB values. Local Miniflare may return a byte array, not an ArrayBuffer. */

export function toUint8Array(data: unknown): Uint8Array {
  if (data == null) return new Uint8Array(0);
  if (data instanceof Uint8Array) return copyBytes(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return copyBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (Array.isArray(data)) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = Number(data[i]) & 0xff;
    return out;
  }
  if (typeof data === "string") {
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }
  if (typeof data === "object") {
    const rec = data as { byteLength?: unknown; length?: unknown; data?: unknown };
    if (Array.isArray(rec.data)) return toUint8Array(rec.data);
    if (typeof rec.length === "number" && rec.length >= 0) {
      const src = data as ArrayLike<number>;
      const out = new Uint8Array(src.length);
      for (let i = 0; i < src.length; i++) out[i] = Number(src[i]) & 0xff;
      return out;
    }
    if (typeof rec.byteLength === "number" && rec.byteLength >= 0) {
      return new Uint8Array(data as ArrayBuffer);
    }
  }
  throw new Error("Unsupported blob value");
}

/** Detach from a shared buffer so Workers can use the bytes as a Response body. */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}
