import { generateJSON } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { marked } from "marked";
import type { TipTapJSON } from "@shared/types";
import { EMPTY_DOC } from "./emptyDoc";

export type ImportDraft = {
  title: string;
  content: TipTapJSON;
  tags: string[];
  sourceName: string;
};

const MAX_FILE_BYTES = 1_500_000;

const IMPORT_EXTENSIONS = [
  StarterKit,
  Highlight,
  TaskList,
  TaskItem.configure({ nested: true }),
];

marked.setOptions({ gfm: true, breaks: false });

/** Turn GFM checkbox lists into TipTap taskList HTML. */
function enhanceTaskLists(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("ul").forEach((ul) => {
    const items = [...ul.children].filter((c) => c.tagName === "LI") as HTMLLIElement[];
    if (!items.length) return;
    const allTasks = items.every((li) => li.querySelector(':scope > input[type="checkbox"]'));
    if (!allTasks) return;
    ul.setAttribute("data-type", "taskList");
    for (const li of items) {
      const cb = li.querySelector(':scope > input[type="checkbox"]') as HTMLInputElement | null;
      if (!cb) continue;
      li.setAttribute("data-type", "taskItem");
      li.setAttribute("data-checked", cb.checked ? "true" : "false");
      cb.remove();
    }
  });
  return doc.body.innerHTML;
}

/** Support `==highlighted==` which marked doesn't know about. */
function prepMarkdown(md: string): string {
  return md.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
}

export function markdownToDoc(md: string): TipTapJSON {
  const rawHtml = marked.parse(prepMarkdown(md), { async: false }) as string;
  const html = enhanceTaskLists(rawHtml);
  try {
    return generateJSON(html, IMPORT_EXTENSIONS) as TipTapJSON;
  } catch {
    return EMPTY_DOC;
  }
}

function parseMetaAndBody(
  md: string,
  fallbackTitle: string,
): { title: string; tags: string[]; body: string } {
  let title = fallbackTitle;
  let tags: string[] = [];
  let body = md.replace(/^\uFEFF/, "").trim();

  const h1 = body.match(/^#\s+(.+?)(?:\r?\n|$)/);
  if (h1) {
    title = h1[1]!.trim() || fallbackTitle;
    body = body.slice(h1[0].length).trim();
  }

  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line) {
      i++;
      continue;
    }
    const tagMatch = line.match(/^Tags:\s*(.+)$/i);
    if (tagMatch) {
      tags = [...tagMatch[1]!.matchAll(/#([^\s#]+)/g)].map((m) => m[1]!.toLowerCase());
      i++;
      continue;
    }
    if (/^Updated:/i.test(line)) {
      i++;
      continue;
    }
    break;
  }
  body = lines.slice(i).join("\n").trim();
  return { title: title.slice(0, 200), tags, body };
}

/** Split OwnNote multi-note markdown exports (`---` between notes). */
export function splitMarkdownNotes(raw: string): string[] {
  const parts = raw.split(/\n{2,}---\n{2,}/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function titleFromFilename(name: string): string {
  return name.replace(/\.(md|markdown|txt)$/i, "").replace(/[_-]+/g, " ").trim() || "Imported note";
}

export function draftsFromMarkdown(raw: string, sourceName: string): ImportDraft[] {
  const chunks = splitMarkdownNotes(raw);
  const fallback = titleFromFilename(sourceName);
  return chunks.map((chunk, idx) => {
    const { title, tags, body } = parseMetaAndBody(chunk, chunks.length > 1 ? `${fallback} (${idx + 1})` : fallback);
    return {
      title,
      tags,
      content: body ? markdownToDoc(body) : EMPTY_DOC,
      sourceName,
    };
  });
}

function isTipTapDoc(v: unknown): v is TipTapJSON {
  return !!v && typeof v === "object" && (v as { type?: string }).type === "doc";
}

/** OwnNote JSON export (`version` + `notes[]`) or a bare TipTap doc. */
export function draftsFromJson(raw: string, sourceName: string): ImportDraft[] {
  const data = JSON.parse(raw) as unknown;
  if (Array.isArray((data as { notes?: unknown }).notes)) {
    const notes = (data as { notes: Array<Record<string, unknown>> }).notes;
    return notes.map((n, i) => {
      const title = typeof n.title === "string" && n.title.trim() ? n.title.trim() : `Imported ${i + 1}`;
      const tags = Array.isArray(n.tags)
        ? n.tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase())
        : [];
      const content = isTipTapDoc(n.content) ? n.content : EMPTY_DOC;
      return { title: title.slice(0, 200), tags, content, sourceName };
    });
  }
  if (isTipTapDoc(data)) {
    return [{ title: titleFromFilename(sourceName), tags: [], content: data, sourceName }];
  }
  throw new Error("Unrecognized JSON note format");
}

export async function draftsFromFile(file: File): Promise<ImportDraft[]> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is too large (max ~1.5 MB)`);
  }
  const text = await file.text();
  const name = file.name || "import.md";
  if (/\.json$/i.test(name) || file.type === "application/json") {
    return draftsFromJson(text, name);
  }
  return draftsFromMarkdown(text, name);
}
