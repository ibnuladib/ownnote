import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextStyle from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Heading2,
  Highlighter,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Redo2,
  Star,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { Note, TipTapJSON } from "@shared/types";
import { api } from "../api";
import { FONT_SIZES, FontSize } from "./fontSize";
import { relativeTime } from "../lib/time";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function insertImageFiles(editor: Editor, noteId: string, files: File[]) {
  const images = files.filter((f) => IMAGE_TYPES.has(f.type));
  for (const file of images) {
    const { url } = await api.uploadAttachment(noteId, file);
    editor.chain().focus().setImage({ src: url, alt: file.name || "image" }).run();
  }
}

type Props = {
  note: Note;
  allTags: string[];
  onTitle: (id: string, title: string) => void;
  onContent: (id: string, content: TipTapJSON) => void;
  onPin: (note: Note) => void;
  onDelete: (note: Note) => void;
  onTags: (note: Note, tags: string[]) => void;
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

export function NoteEditor({ note, allTags, onTitle, onContent, onPin, onDelete, onTags }: Props) {
  const [title, setTitle] = useState(note.title);
  const [confirming, setConfirming] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editorRef = useRef<Editor | null>(null);
  const noteId = note.id;
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        TextStyle,
        FontSize,
        Image.configure({ inline: false, allowBase64: false }),
        Highlight.extend({
          addKeyboardShortcuts() {
            return {
              "Mod-Shift-h": () => this.editor.commands.toggleHighlight(),
            };
          },
        }).configure({ multicolor: false }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({ placeholder: "Start writing. Tick things off as you learn them." }),
      ],
      content: isDoc(note.content) ? (cleanNode(note.content) as TipTapJSON) : "",
      editorProps: {
        attributes: { class: "prose", spellcheck: "true" },
        handlePaste(_view, event) {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (!files.some((f) => IMAGE_TYPES.has(f.type))) return false;
          event.preventDefault();
          const ed = editorRef.current;
          if (ed) void insertImageFiles(ed, noteIdRef.current, files).catch(() => undefined);
          return true;
        },
        handleDrop(_view, event) {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (!files.some((f) => IMAGE_TYPES.has(f.type))) return false;
          event.preventDefault();
          const ed = editorRef.current;
          if (ed) void insertImageFiles(ed, noteIdRef.current, files).catch(() => undefined);
          return true;
        },
      },
      onCreate: ({ editor: ed }) => {
        editorRef.current = ed;
      },
      onUpdate: ({ editor: ed }) => {
        editorRef.current = ed;
        onContent(noteIdRef.current, ed.getJSON() as TipTapJSON);
      },
    },
    [noteId],
  );

  useEffect(() => () => clearTimeout(confirmTimer.current), []);

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

      <Toolbar editor={editor} />

      <div className="editor-scroll" onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
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
      {btn("Undo", false, () => editor.chain().focus().undo().run(), <Undo2 size={16} />, "Ctrl+Z")}
      {btn("Redo", false, () => editor.chain().focus().redo().run(), <Redo2 size={16} />, "Ctrl+Shift+Z")}
    </div>
  );
}
