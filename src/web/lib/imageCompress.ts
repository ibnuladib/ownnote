/**
 * Client-side image compression so retina screenshots (>900KB) fit comfortably
 * inside D1's single-row BLOB budget without failing with HTTP 413.
 */

const TARGET_MAX_BYTES = 820 * 1024;
const MAX_DIMENSION = 1920;

export async function prepareImageForUpload(file: File): Promise<File> {
  // GIFs (potentially animated) or already-compact images pass straight through.
  if (file.type === "image/gif" || file.size <= TARGET_MAX_BYTES) {
    return file;
  }
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    return file;
  }

  try {
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
      width = Math.max(1, Math.round(width * ratio));
      height = Math.max(1, Math.round(height * ratio));
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const qualities = [0.86, 0.74, 0.6, 0.48];
    for (const q of qualities) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/webp", q),
      );
      if (blob && blob.size <= TARGET_MAX_BYTES) {
        const base = (file.name || "image").replace(/\.[^.]+$/, "");
        return new File([blob], `${base}.webp`, { type: "image/webp" });
      }
    }
  } catch {
    /* fallback to original file */
  }
  return file;
}
