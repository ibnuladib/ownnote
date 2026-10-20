import type { TipTapJSON } from "@shared/types";

/** Mirrors worker EMPTY_DOC so the web bundle doesn't import worker code. */
export const EMPTY_DOC: TipTapJSON = { type: "doc", content: [{ type: "paragraph" }] };
