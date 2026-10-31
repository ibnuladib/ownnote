import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextStyle from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Brain,
  Code2,
  Eye,
  EyeOff,
  FileText,
  Heading1,
  Heading2,
  Highlighter,
  ImageIcon,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  ListTree,
  Minus,
  Quote,
  Redo2,
  Sparkles,
  Star,
  Timer,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { Note, TipTapJSON } from "@shared/types";
import { api, ApiError } from "../api";
import { ClozeMark } from "../extensions/clozeMark";
import { PdfAnchor } from "../extensions/pdfAnchor";
import { insertEditorImage, ResizableImage } from "../extensions/resizableImage";
import { TimestampChip } from "../extensions/timestampChip";
import { prepareImageForUpload } from "../lib/imageCompress";
import { relativeTime } from "../lib/time";
import { FONT_SIZES, FontSize } from "./fontSize";
import { extractStudyCards, StudyModal } from "./StudyModal";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function isImageFile(f: File): boolean {
  return IMAGE_TYPES.has(f.type) || /\.(png|jpe?g|gif|webp)$/i.test(f.name);
}

function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromFiles = Array.from(data.files ?? []).filter(isImageFile);
  if (fromFiles.length) return fromFiles;
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f && isImageFile(f)) fromItems.push(f);
  }
  return fromItems;
}

async function insertImageFiles(
  editor: Editor,
  noteId: string,
  files: File[],
  onError?: (msg: string) => void,
) {
  const images = files.filter(isImageFile);
  if (!images.length) return;
  for (const rawFile of images) {
    try {
      const file = await prepareImageForUpload(rawFile);
      const { url } = await api.uploadAttachment(noteId, file);
      const ok = insertEditorImage(editor, url, rawFile.name || "image");
      if (!ok) onError?.("Couldn't insert the image into the note.");
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Image upload failed.";
      onError?.(msg);
    }
  }
}

export type NoteEditorHandle = {
  insertPdfCitation: (attrs: {
    pdfId: string;
    page: number;
    label?: string;
    quote?: string;
  }) => void;
  toggleRecallMode: () => void;
  openStudyModal: () => void;
};

type Props = {
  note: Note;
  allTags: string[];
  onTitle: (id: string, title: string) => void;
  onContent: (id: string, content: TipTapJSON) => void;
  onPin: (note: Note) => void;
  onDelete: (note: Note) => void;
  onTags: (note: Note, tags: string[]) => void;
  /** Active YouTube id + live clock from the watch pane (may be null). */
  getTimestampContext?: () => { youtubeId: string; seconds: number } | null;
  onSeekTimestamp?: (youtubeId: string, seconds: number) => void;
  /** Active PDF id + page from the PDF pane (may be null). */
  getPdfContext?: () => { pdfId: string; title: string; page: number } | null;
  onSeekPdf?: (pdfId: string, page: number) => void;
  onNotify?: (msg: string) => void;
};

function isDoc(c: unknown): c is TipTapJSON {
  return !!c && typeof c === "object" && (c as TipTapJSON).type === "doc";
}

/** ProseMirror rejects empty text nodes (the shared template contains one); drop them. */
function cleanNode(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (!Array.isArray(n.content)) return n;
  return {
    ...n,
    content: n.content
      .filter((c) => !(c && (c as { type?: string; text?: string }).type === "text" && !(c as { text?: string }).text))
      .map(cleanNode),
  };
}

type DocStats = {
  words: number;
  readMin: number;
  tasksDone: number;
  tasksTotal: number;
  timestamps: number;
  pdfRefs: number;
  headings: Array<{ level: number; text: string; index: number }>;
};

function computeDocStats(doc: TipTapJSON): DocStats {
  let textAcc = "";
  let tasksDone = 0;
  let tasksTotal = 0;
  let timestamps = 0;
  let pdfRefs = 0;
  let headingIdx = 0;
  const headings: Array<{ level: number; text: string; index: number }> = [];

  type N = {
    type?: string;
    text?: string;
    attrs?: Record<string, unknown>;
    content?: N[];
  };

  const inlineText = (nodes: N[] | undefined): string =>
    (nodes ?? [])
      .map((n) => (typeof n.text === "string" ? n.text : inlineText(n.content)))
      .join("");

  const walk = (n: N) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.text === "string") textAcc += " " + n.text;
    if (n.type === "taskItem") {
      tasksTotal++;
      if (n.attrs?.checked) tasksDone++;
    } else if (n.type === "timestampChip") {
      timestamps++;
    } else if (n.type === "pdfAnchor") {
      pdfRefs++;
    } else if (n.type === "heading") {
      const hText = inlineText(n.content).trim();
      const idx = headingIdx++;
      if (hText) {
        headings.push({
          level: Math.min(3, Math.max(1, Number(n.attrs?.level) || 2)),
          text: hText,
          index: idx,
        });
      }
    }
    if (Array.isArray(n.content)) {
      for (const c of n.content) walk(c);
    }
  };

  walk(doc as N);
  const words = textAcc.trim() ? textAcc.trim().split(/\s+/).length : 0;
  const readMin = Math.max(1, Math.ceil(words / 200));
  return { words, readMin, tasksDone, tasksTotal, timestamps, pdfRefs, headings };
}

type SlashItem = {
  key: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  run: (editor: Editor) => void;
};

export const NoteEditor = forwardRef<NoteEditorHandle, Props>(function NoteEditor(
  {
    note,
    allTags,
    onTitle,
    onContent,
    onPin,
    onDelete,
    onTags,
    getTimestampContext,
    onSeekTimestamp,
    getPdfContext,
    onSeekPdf,
    onNotify,
  },
  ref,
) {
  const [title, setTitle] = useState(note.title);
  const [confirming, setConfirming] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [recallMode, setRecallMode] = useState(false);
  const [studyOpen, setStudyOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [liveDoc, setLiveDoc] = useState<TipTapJSON>(() =>
    isDoc(note.content) ? (cleanNode(note.content) as TipTapJSON) : { type: "doc", content: [] },
  );

  // Slash command menu state
  const [slashState, setSlashState] = useState<{
    open: boolean;
    query: string;
    from: number;
    to: number;
    selIndex: number;
  } | null>(null);

  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const noteId = note.id;
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  const seekRef = useRef(onSeekTimestamp);
  seekRef.current = onSeekTimestamp;
  const seekPdfRef = useRef(onSeekPdf);
  seekPdfRef.current = onSeekPdf;
  const notifyRef = useRef(onNotify);
  notifyRef.current = onNotify;
  const recallRef = useRef(recallMode);
  recallRef.current = recallMode;

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        TextStyle,
        FontSize,
        ResizableImage.configure({ inline: false, allowBase64: false }),
        TimestampChip,
        PdfAnchor,
        ClozeMark,
        Highlight.extend({
          addKeyboardShortcuts() {
            return {
              "Mod-Shift-h": () => this.editor.commands.toggleHighlight(),
            };
          },
        }).configure({ multicolor: false }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({
          placeholder: "Start writing, type / for commands, or wrap {{terms}} for active recall…",
        }),
      ],
      content: isDoc(note.content) ? (cleanNode(note.content) as TipTapJSON) : "",
      editorProps: {
        attributes: { class: "prose", spellcheck: "true" },
        handlePaste(_view, event) {
          const files = filesFromClipboard(event.clipboardData);
          if (!files.length) return false;
          event.preventDefault();
          const ed = editorRef.current;
          if (ed) {
            void insertImageFiles(ed, noteIdRef.current, files, (m) => notifyRef.current?.(m));
          }
          return true;
        },
        handleDrop(_view, event) {
          const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile);
          if (!files.length) return false;
          event.preventDefault();
          const ed = editorRef.current;
          if (ed) {
            void insertImageFiles(ed, noteIdRef.current, files, (m) => notifyRef.current?.(m));
          }
          return true;
        },
        handleDOMEvents: {
          click: (_view, event) => {
            const target = event.target as HTMLElement | null;
            if (!target) return false;

            // Active recall click-to-reveal on cloze or highlight spans
            if (recallRef.current) {
              const clozeEl = target.closest?.("[data-cloze], mark") as HTMLElement | null;
              if (clozeEl) {
                event.preventDefault();
                const revealed = clozeEl.getAttribute("data-revealed") === "true";
                clozeEl.setAttribute("data-revealed", revealed ? "false" : "true");
                return true;
              }
            }

            const tsEl = target.closest?.("[data-timestamp-chip]") as HTMLElement | null;
            if (tsEl) {
              const youtubeId = tsEl.getAttribute("data-youtube-id") || "";
              const seconds = Number(tsEl.getAttribute("data-seconds") || 0);
              if (!youtubeId) return false;
              event.preventDefault();
              seekRef.current?.(youtubeId, seconds);
              return true;
            }

            const pdfEl = target.closest?.("[data-pdf-anchor]") as HTMLElement | null;
            if (pdfEl) {
              const pdfId = pdfEl.getAttribute("data-pdf-id") || "";
              const page = Math.max(1, Number(pdfEl.getAttribute("data-page") || 1));
              if (!pdfId) return false;
              event.preventDefault();
              seekPdfRef.current?.(pdfId, page);
              return true;
            }

            return false;
          },
        },
      },
      onCreate: ({ editor: ed }) => {
        editorRef.current = ed;
      },
      onUpdate: ({ editor: ed }) => {
        editorRef.current = ed;
        const json = ed.getJSON() as TipTapJSON;
        setLiveDoc(json);
        onContent(noteIdRef.current, json);

        // Detect slash command token `/...` at current cursor in paragraph
        const { selection } = ed.state;
        if (!selection.empty) {
          setSlashState(null);
          return;
        }
        const $from = selection.$from;
        if ($from.parent.type.name !== "paragraph") {
          setSlashState(null);
          return;
        }
        const textBefore = $from.parent.textBetween(0, $from.parentOffset, "\n", "\0");
        const match = textBefore.match(/(?:^|\s)\/([a-zA-Z0-9_-]{0,16})$/);
        if (match) {
          const query = match[1]!.toLowerCase();
          const slashPos = $from.pos - query.length - 1;
          setSlashState((prev) => ({
            open: true,
            query,
            from: slashPos,
            to: $from.pos,
            selIndex: prev?.query === query ? prev.selIndex : 0,
          }));
        } else {
          setSlashState(null);
        }
      },
    },
    [noteId],
  );

  useImperativeHandle(
    ref,
    () => ({
      insertPdfCitation: (attrs) => {
        const ed = editorRef.current;
        if (!ed) return;
        ed.chain().focus().insertPdfAnchor(attrs).insertContent(" ").run();
      },
      toggleRecallMode: () => setRecallMode((r) => !r),
      openStudyModal: () => setStudyOpen(true),
    }),
    [],
  );

  const slashItems = useMemo<SlashItem[]>(
    () => [
      {
        key: "h1",
        label: "Heading 1",
        hint: "/h1",
        icon: <Heading1 size={15} />,
        run: (ed) => ed.chain().focus().toggleHeading({ level: 1 }).run(),
      },
      {
        key: "h2",
        label: "Heading 2",
        hint: "/h2",
        icon: <Heading2 size={15} />,
        run: (ed) => ed.chain().focus().toggleHeading({ level: 2 }).run(),
      },
      {
        key: "todo",
        label: "Checklist item",
        hint: "/todo",
        icon: <ListChecks size={15} />,
        run: (ed) => ed.chain().focus().toggleTaskList().run(),
      },
      {
        key: "bullet",
        label: "Bullet list",
        hint: "/bullet",
        icon: <List size={15} />,
        run: (ed) => ed.chain().focus().toggleBulletList().run(),
      },
      {
        key: "numbered",
        label: "Numbered list",
        hint: "/num",
        icon: <ListOrdered size={15} />,
        run: (ed) => ed.chain().focus().toggleOrderedList().run(),
      },
      {
        key: "cloze",
        label: "Active recall cloze",
        hint: "{{term}}",
        icon: <Brain size={15} />,
        run: (ed) =>
          ed
            .chain()
            .focus()
            .insertContent({
              type: "text",
              marks: [{ type: "cloze" }],
              text: "key concept",
            })
            .insertContent(" ")
            .run(),
      },
      {
        key: "code",
        label: "Code block",
        hint: "/code",
        icon: <Code2 size={15} />,
        run: (ed) => ed.chain().focus().toggleCodeBlock().run(),
      },
      {
        key: "quote",
        label: "Callout / Blockquote",
        hint: "/quote",
        icon: <Quote size={15} />,
        run: (ed) => ed.chain().focus().toggleBlockquote().run(),
      },
      {
        key: "time",
        label: "YouTube timestamp",
        hint: "/time",
        icon: <Timer size={15} />,
        run: (ed) => {
          const ctx = getTimestampContext?.();
          if (!ctx) {
            notifyRef.current?.("Select a YouTube video first to insert a timestamp.");
            return;
          }
          ed.chain().focus().insertTimestampChip(ctx).insertContent(" ").run();
        },
      },
      {
        key: "pdf",
        label: "Cite active PDF page",
        hint: "/pdf",
        icon: <FileText size={15} />,
        run: (ed) => {
          const ctx = getPdfContext?.();
          if (!ctx) {
            notifyRef.current?.("Open a PDF in the right panel first to cite a page.");
            return;
          }
          const short = ctx.title.length > 20 ? `${ctx.title.slice(0, 19)}…` : ctx.title;
          ed
            .chain()
            .focus()
            .insertPdfAnchor({
              pdfId: ctx.pdfId,
              page: ctx.page,
              label: `${short} p.${ctx.page}`,
            })
            .insertContent(" ")
            .run();
        },
      },
      {
        key: "divider",
        label: "Divider line",
        hint: "/hr",
        icon: <Minus size={15} />,
        run: (ed) => ed.chain().focus().setHorizontalRule().run(),
      },
    ],
    [getPdfContext, getTimestampContext],
  );

  const filteredSlash = useMemo(() => {
    if (!slashState?.open) return [];
    const q = slashState.query;
    if (!q) return slashItems;
    return slashItems.filter(
      (item) =>
        item.key.includes(q) ||
        item.label.toLowerCase().includes(q) ||
        item.hint.toLowerCase().includes(q),
    );
  }, [slashItems, slashState]);

  function executeSlash(item: SlashItem) {
    const ed = editorRef.current;
    if (!ed || !slashState) return;
    ed.chain().focus().deleteRange({ from: slashState.from, to: slashState.to }).run();
    item.run(ed);
    setSlashState(null);
  }

  useEffect(() => () => clearTimeout(confirmTimer.current), []);

  const stats = useMemo(() => computeDocStats(liveDoc), [liveDoc]);
  const studyCardCount = useMemo(
    () => extractStudyCards(liveDoc, title).length,
    [liveDoc, title],
  );

  function askDelete() {
    if (!confirming) {
      setConfirming(true);
      confirmTimer.current = setTimeout(() => setConfirming(false), 3500);
      return;
    }
    clearTimeout(confirmTimer.current);
    onDelete(note);
  }

  function addTag(raw: string) {
    const t = raw.trim().replace(/^#/, "").toLowerCase();
    setTagDraft("");
    if (!t || note.tags.includes(t)) return;
    onTags(note, [...note.tags, t]);
  }

  function tagKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagDraft);
    } else if (e.key === "Backspace" && !tagDraft && note.tags.length) {
      onTags(note, note.tags.slice(0, -1));
    }
  }

  function scrollToHeading(index: number) {
    const container = scrollRef.current;
    if (!container) return;
    const nodes = container.querySelectorAll(".prose h1, .prose h2, .prose h3");
    const target = nodes[index] as HTMLElement | undefined;
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      setOutlineOpen(false);
    }
  }

  const suggestions = allTags.filter((t) => !note.tags.includes(t));

  return (
    <div className="editor-wrap">
      <header className="note-head">
        <input
          className="note-title"
          value={title}
          placeholder="Untitled"
          aria-label="Note title"
          onChange={(e) => {
            setTitle(e.target.value);
            onTitle(noteId, e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              editor?.commands.focus("start");
            }
          }}
        />
        <div className="note-actions">
          <button
            type="button"
            className={`icon-btn ${recallMode ? "is-on" : ""}`}
            onClick={() => {
              setRecallMode((r) => {
                const next = !r;
                if (!next && scrollRef.current) {
                  scrollRef.current
                    .querySelectorAll("[data-revealed]")
                    .forEach((el) => el.removeAttribute("data-revealed"));
                }
                return next;
              });
            }}
            aria-pressed={recallMode}
            title={
              recallMode
                ? "Exit Recall mode (reveal all)"
                : "Active Recall mode: mask {{cloze}} and highlights to test yourself"
            }
          >
            {recallMode ? <Eye size={16} /> : <EyeOff size={16} />}
            <span className="hide-sm">Recall</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setStudyOpen(true)}
            title="Practice Flashcards extracted from this note"
          >
            <Brain size={16} />
            <span className="hide-sm">Quiz</span>
            {studyCardCount > 0 && <span className="mini-badge">{studyCardCount}</span>}
          </button>
          <button
            className={`icon-btn ${note.pinned ? "is-on" : ""}`}
            onClick={() => onPin(note)}
            aria-pressed={note.pinned}
            title={note.pinned ? "Unpin" : "Pin to top"}
          >
            <Star size={17} fill={note.pinned ? "currentColor" : "none"} />
          </button>
          <button
            className={`icon-btn danger ${confirming ? "is-armed" : ""}`}
            onClick={askDelete}
            title="Delete note"
          >
            <Trash2 size={17} />
            {confirming && <span>Delete?</span>}
          </button>
        </div>
      </header>

      <div className="note-meta">
        <ul className="tag-row">
          {note.tags.map((t) => (
            <li key={t} className="tag-chip">
              <span>#{t}</span>
              <button
                aria-label={`Remove tag ${t}`}
                onClick={() => onTags(note, note.tags.filter((x) => x !== t))}
              >
                <X size={12} />
              </button>
            </li>
          ))}
          <li>
            <input
              className="tag-input"
              placeholder={note.tags.length ? "add tag" : "+ tag"}
              value={tagDraft}
              list="all-tags"
              aria-label="Add tag"
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={tagKey}
              onBlur={() => tagDraft && addTag(tagDraft)}
            />
            <datalist id="all-tags">
              {suggestions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </li>
        </ul>
        <span className="note-stamp">edited {relativeTime(note.updated_at)}</span>
      </div>

      <Toolbar
        editor={editor}
        getTimestampContext={getTimestampContext}
        getPdfContext={getPdfContext}
        onPickImage={() => imageInputRef.current?.click()}
        onNotify={onNotify}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          const ed = editorRef.current;
          if (ed && files.length) {
            void insertImageFiles(ed, noteIdRef.current, files, (m) => notifyRef.current?.(m));
          }
        }}
      />

      <div
        ref={scrollRef}
        className="editor-scroll"
        data-recall={recallMode ? "true" : "false"}
        onClick={(e) => {
          if (e.target === e.currentTarget) editor?.commands.focus();
        }}
        onKeyDownCapture={(e) => {
          if (!slashState?.open || filteredSlash.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSlashState((s) =>
              s ? { ...s, selIndex: (s.selIndex + 1) % filteredSlash.length } : null,
            );
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSlashState((s) =>
              s
                ? {
                    ...s,
                    selIndex: (s.selIndex - 1 + filteredSlash.length) % filteredSlash.length,
                  }
                : null,
            );
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            const pick = filteredSlash[slashState.selIndex] ?? filteredSlash[0];
            if (pick) executeSlash(pick);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setSlashState(null);
          }
        }}
      >
        <EditorContent editor={editor} />

        {slashState?.open && filteredSlash.length > 0 && (
          <div className="slash-menu" role="listbox" aria-label="Quick insert commands">
            <div className="slash-menu-head">
              <Sparkles size={12} />
              <span>Insert block or study anchor</span>
            </div>
            {filteredSlash.map((item, idx) => (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={idx === slashState.selIndex}
                data-sel={idx === slashState.selIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  executeSlash(item);
                }}
                onMouseEnter={() =>
                  setSlashState((s) => (s ? { ...s, selIndex: idx } : null))
                }
              >
                <span className="slash-icon">{item.icon}</span>
                <span className="slash-label">{item.label}</span>
                <kbd>{item.hint}</kbd>
              </button>
            ))}
          </div>
        )}
      </div>

      <footer className="editor-foot">
        <div className="editor-stats">
          <span>{stats.words} {stats.words === 1 ? "word" : "words"}</span>
          <span>·</span>
          <span>~{stats.readMin} min read</span>
          {stats.tasksTotal > 0 && (
            <>
              <span>·</span>
              <span className="stat-accent">
                {stats.tasksDone}/{stats.tasksTotal} checkpoints
              </span>
            </>
          )}
          {stats.timestamps > 0 && (
            <>
              <span>·</span>
              <span>{stats.timestamps} ⏱</span>
            </>
          )}
          {stats.pdfRefs > 0 && (
            <>
              <span>·</span>
              <span>{stats.pdfRefs} 📄</span>
            </>
          )}
        </div>

        {stats.headings.length > 0 && (
          <div className="outline-wrap">
            <button
              type="button"
              className={`outline-btn ${outlineOpen ? "is-on" : ""}`}
              onClick={() => setOutlineOpen((o) => !o)}
              aria-expanded={outlineOpen}
            >
              <ListTree size={13} />
              <span>Outline ({stats.headings.length})</span>
            </button>
            {outlineOpen && (
              <div className="outline-pop" role="menu" aria-label="Document outline">
                <div className="outline-head">Jump to section</div>
                <ul>
                  {stats.headings.map((h) => (
                    <li key={h.index} data-level={h.level}>
                      <button type="button" onClick={() => scrollToHeading(h.index)}>
                        {h.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </footer>

      {studyOpen && (
        <StudyModal
          note={{ ...note, title, content: liveDoc }}
          onClose={() => setStudyOpen(false)}
        />
      )}
    </div>
  );
});

function Toolbar({
  editor,
  getTimestampContext,
  getPdfContext,
  onPickImage,
  onNotify,
}: {
  editor: Editor | null;
  getTimestampContext?: () => { youtubeId: string; seconds: number } | null;
  getPdfContext?: () => { pdfId: string; title: string; page: number } | null;
  onPickImage: () => void;
  onNotify?: (msg: string) => void;
}) {
  if (!editor) return <div className="toolbar" />;
  const size = (editor.getAttributes("textStyle").fontSize as string | null) ?? "";
  const btn = (
    label: string,
    active: boolean,
    run: () => void,
    icon: React.ReactNode,
    hint?: string,
  ) => (
    <button
      type="button"
      className={`tb-btn ${active ? "is-on" : ""}`}
      aria-label={label}
      aria-pressed={active}
      title={hint ? `${label} (${hint})` : label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {icon}
    </button>
  );

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {btn("Bold", editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), <Bold size={16} />, "Ctrl+B")}
      {btn("Italic", editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), <Italic size={16} />, "Ctrl+I")}
      {btn(
        "Highlight",
        editor.isActive("highlight"),
        () => editor.chain().focus().toggleHighlight().run(),
        <Highlighter size={16} />,
        "Ctrl+Shift+H",
      )}
      {btn(
        "Cloze recall",
        editor.isActive("cloze"),
        () => editor.chain().focus().toggleCloze().run(),
        <Brain size={16} />,
        "Ctrl+Shift+K or {{text}}",
      )}
      {btn("Heading", editor.isActive("heading", { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), <Heading2 size={16} />)}
      <span className="tb-sep" />
      <select
        className="tb-select"
        aria-label="Font size"
        value={size}
        onChange={(e) => {
          const v = e.target.value;
          const chain = editor.chain().focus();
          if (v) chain.setMark("textStyle", { fontSize: v }).run();
          else chain.setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run();
        }}
      >
        <option value="">Size</option>
        {FONT_SIZES.map((s) => (
          <option key={s} value={s}>
            {s.replace("px", "")}
          </option>
        ))}
      </select>
      <span className="tb-sep" />
      {btn("Bullet list", editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), <List size={16} />)}
      {btn("Numbered list", editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run(), <ListOrdered size={16} />)}
      {btn("Checklist", editor.isActive("taskList"), () => editor.chain().focus().toggleTaskList().run(), <ListChecks size={16} />)}
      <span className="tb-sep" />
      {btn("Insert image", false, onPickImage, <ImageIcon size={16} />, "Upload or paste")}
      {btn(
        "Insert timestamp",
        false,
        () => {
          const ctx = getTimestampContext?.();
          if (!ctx) {
            onNotify?.("Play or select a YouTube video first to insert a timestamp.");
            return;
          }
          editor.chain().focus().insertTimestampChip(ctx).run();
        },
        <Timer size={16} />,
        "Current video time",
      )}
      {btn(
        "Cite PDF page",
        false,
        () => {
          const ctx = getPdfContext?.();
          if (!ctx) {
            onNotify?.("Open a PDF in the right panel first to cite a page.");
            return;
          }
          const short = ctx.title.length > 20 ? `${ctx.title.slice(0, 19)}…` : ctx.title;
          editor
            .chain()
            .focus()
            .insertPdfAnchor({
              pdfId: ctx.pdfId,
              page: ctx.page,
              label: `${short} p.${ctx.page}`,
            })
            .run();
        },
        <FileText size={16} />,
        "Cite active PDF page",
      )}
      <span className="tb-sep" />
      {btn("Undo", false, () => editor.chain().focus().undo().run(), <Undo2 size={16} />, "Ctrl+Z")}
      {btn("Redo", false, () => editor.chain().focus().redo().run(), <Redo2 size={16} />, "Ctrl+Shift+Z")}
    </div>
  );
}
