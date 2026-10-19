import type { Note } from "@shared/types";
import { api, type NotePatch } from "../api";

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

type Handlers = {
  onStatus: (s: SaveState) => void;
  onSaved: (note: Note) => void;
};

/**
 * Debounced, ordered PATCH queue. Edits to one note are merged; switching
 * notes flushes the previous note first. Requests are serialised so older
 * content can never overwrite newer content.
 */
export class Saver {
  private pending: { id: string; patch: NotePatch } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private delay: number,
    private handlers: Handlers,
  ) {}

  queue(id: string, patch: NotePatch) {
    if (this.pending && this.pending.id !== id) void this.flush();
    this.pending = { id, patch: { ...(this.pending?.patch ?? {}), ...patch } };
    this.handlers.onStatus("dirty");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }

  /** Discard unsaved edits for a note (e.g. after deleting it). */
  drop(id: string) {
    if (this.pending?.id === id) {
      this.pending = null;
      clearTimeout(this.timer);
      this.handlers.onStatus("idle");
    }
  }

  get dirty() {
    return this.pending !== null;
  }

  flush(keepalive = false): Promise<void> {
    clearTimeout(this.timer);
    const job = this.pending;
    if (!job) return this.chain;
    this.pending = null;
    this.handlers.onStatus("saving");
    this.chain = this.chain.then(async () => {
      try {
        const note = await api.patchNote(job.id, job.patch, keepalive);
        this.handlers.onSaved(note);
        if (!this.pending) this.handlers.onStatus("saved");
      } catch {
        this.handlers.onStatus("error");
        // Re-queue (newer edits win) and retry shortly.
        this.pending = {
          id: job.id,
          patch: { ...job.patch, ...(this.pending?.id === job.id ? this.pending.patch : {}) },
        };
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.flush(), 4000);
      }
    });
    return this.chain;
  }
}
