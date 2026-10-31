import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  BookOpenCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  FileUp,
  Quote,
  Trash2,
} from "lucide-react";
import type { NotePdf, PdfStatus } from "@shared/types";
import { api, ApiError, pdfFileUrl } from "../api";

export type PdfPanelHandle = {
  getActivePdfContext: () => { pdfId: string; title: string; page: number } | null;
  jumpToPdf: (pdfId: string, page: number) => void;
};

type Props = {
  noteId: string | null;
  onInsertCitation?: (attrs: {
    pdfId: string;
    page: number;
    label: string;
    quote?: string;
  }) => void;
  onNotify?: (msg: string) => void;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortTitle(title: string, max = 22): string {
  const clean = title.trim() || "PDF";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export const PdfPanel = forwardRef<PdfPanelHandle, Props>(function PdfPanel(
  { noteId, onInsertCitation, onNotify },
  ref,
) {
  const [pdfs, setPdfs] = useState<NotePdf[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoteDraft, setQuoteDraft] = useState("");
  const [flashPage, setFlashPage] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<string | null>(noteId);
  noteRef.current = noteId;
  const pdfsRef = useRef<NotePdf[]>(pdfs);
  pdfsRef.current = pdfs;
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;
  const pageSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const current = useMemo(
    () => pdfs.find((p) => p.id === selectedId) ?? null,
    [pdfs, selectedId],
  );

  const updatePage = useCallback((pdf: NotePdf, nextPage: number) => {
    const clamped = Math.max(1, Math.min(pdf.page_count || 9999, Math.round(nextPage) || 1));
    const nextStatus: PdfStatus =
      pdf.status === "done"
        ? "done"
        : clamped >= pdf.page_count && pdf.page_count > 1
          ? "done"
          : clamped > 1
            ? "reading"
            : pdf.status;

    setPdfs((list) =>
      list.map((item) =>
        item.id === pdf.id
          ? { ...item, current_page: clamped, status: nextStatus }
          : item,
      ),
    );

    clearTimeout(pageSaveTimer.current);
    pageSaveTimer.current = setTimeout(() => {
      api
        .patchPdf(pdf.id, { current_page: clamped, status: nextStatus })
        .then((saved) => {
          setPdfs((list) => list.map((x) => (x.id === saved.id ? saved : x)));
        })
        .catch(() => {});
    }, 350);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getActivePdfContext: () => {
        const active = pdfsRef.current.find((p) => p.id === selectedRef.current);
        if (!active) return null;
        return {
          pdfId: active.id,
          title: active.title,
          page: active.current_page || 1,
        };
      },
      jumpToPdf: (pdfId: string, page: number) => {
        const target = pdfsRef.current.find((p) => p.id === pdfId);
        if (!target) {
          onNotify?.("That PDF isn't attached to this note.");
          return;
        }
        setSelectedId(target.id);
        selectedRef.current = target.id;
        updatePage(target, page);
        setFlashPage(true);
        setTimeout(() => setFlashPage(false), 900);
      },
    }),
    [onNotify, updatePage],
  );

  useEffect(() => {
    setError(null);
    setQuoteDraft("");
    if (!noteId) {
      setPdfs([]);
      setSelectedId(null);
      return;
    }
    let live = true;
    setLoading(true);
    api
      .listPdfs(noteId)
      .then((list) => {
        if (!live) return;
        setPdfs(list);
        const first = list[0] ?? null;
        setSelectedId((prev) => (prev && list.some((x) => x.id === prev) ? prev : first?.id ?? null));
      })
      .catch(() => {
        if (live) setError("Couldn't load PDFs for this note.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [noteId]);

  useEffect(() => () => clearTimeout(pageSaveTimer.current), []);

  async function handleFiles(files: FileList | File[]) {
    if (!noteId || uploading) return;
    const list = Array.from(files).filter(
      (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name),
    );
    if (!list.length) {
      setError("Please choose a valid .pdf file.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      for (const file of list) {
        const created = await api.uploadPdf(noteId, file);
        if (noteRef.current !== noteId) return;
        setPdfs((prev) => [...prev, created]);
        setSelectedId(created.id);
      }
      onNotify?.(list.length === 1 ? "PDF attached to note." : `Attached ${list.length} PDFs.`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Failed to upload PDF.";
      setError(msg);
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) {
      void handleFiles(e.dataTransfer.files);
    }
  }

  async function toggleDone(pdf: NotePdf) {
    const nextStatus: PdfStatus = pdf.status === "done" ? "reading" : "done";
    const prev = pdf.status;
    setPdfs((list) => list.map((x) => (x.id === pdf.id ? { ...x, status: nextStatus } : x)));
    try {
      const saved = await api.patchPdf(pdf.id, { status: nextStatus });
      setPdfs((list) => list.map((x) => (x.id === saved.id ? saved : x)));
    } catch {
      setPdfs((list) => list.map((x) => (x.id === pdf.id ? { ...x, status: prev } : x)));
      setError("Couldn't update PDF status.");
    }
  }

  async function removePdf(pdf: NotePdf) {
    const prev = pdfs;
    const remaining = pdfs.filter((x) => x.id !== pdf.id);
    setPdfs(remaining);
    if (selectedId === pdf.id) {
      setSelectedId(remaining[0]?.id ?? null);
    }
    try {
      await api.deletePdf(pdf.id);
    } catch {
      setPdfs(prev);
      setError("Couldn't remove PDF.");
    }
  }

  function citeCurrentPage() {
    if (!current) return;
    const label = `${shortTitle(current.title)} p.${current.current_page}`;
    onInsertCitation?.({
      pdfId: current.id,
      page: current.current_page,
      label,
      quote: quoteDraft.trim() || undefined,
    });
    setQuoteDraft("");
    onNotify?.(`Cited ${label} in note`);
  }

  const doneCount = useMemo(() => pdfs.filter((p) => p.status === "done").length, [pdfs]);

  return (
    <div
      className={`pdf-wrap ${dragOver ? "is-dragover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="pdf-subhead">
        <div className="list-title">
          <h2>Reading shelf</h2>
          {pdfs.length > 0 && (
            <span className="count">
              {doneCount}/{pdfs.length}
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn-new sm"
          disabled={!noteId || uploading}
          onClick={() => fileInputRef.current?.click()}
          title="Upload a PDF paper or textbook chapter (up to 10 MB)"
        >
          <FileUp size={15} />
          <span>{uploading ? "Uploading…" : "Add PDF"}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {current ? (
        <div className={`pdf-stage ${flashPage ? "is-flashing" : ""}`}>
          <div className="pdf-viewer-frame">
            <iframe
              key={`${current.id}:${current.current_page}`}
              className="pdf-iframe"
              src={`${pdfFileUrl(current.id)}#page=${current.current_page}&view=FitH&toolbar=1`}
              title={current.title}
            />
          </div>

          <div className="pdf-controls">
            <div className="pdf-pager">
              <button
                type="button"
                className="icon-btn sm"
                disabled={current.current_page <= 1}
                onClick={() => updatePage(current, current.current_page - 1)}
                aria-label="Previous PDF page"
                title="Previous page"
              >
                <ChevronLeft size={16} />
              </button>
              <label className="pdf-page-input" title="Current page">
                <span>p.</span>
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, current.page_count)}
                  value={current.current_page}
                  aria-label="Current PDF page"
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 1) updatePage(current, v);
                  }}
                />
                <span>/ {current.page_count}</span>
              </label>
              <button
                type="button"
                className="icon-btn sm"
                disabled={current.current_page >= current.page_count}
                onClick={() => updatePage(current, current.current_page + 1)}
                aria-label="Next PDF page"
                title="Next page"
              >
                <ChevronRight size={16} />
              </button>
            </div>

            <div className="pdf-actions-right">
              <button
                type="button"
                className="btn-cite"
                onClick={citeCurrentPage}
                title="Insert clickable PDF page citation into note"
              >
                <Quote size={13} />
                <span>Cite p.{current.current_page}</span>
              </button>
              <a
                className="icon-btn sm"
                href={`${pdfFileUrl(current.id)}#page=${current.current_page}`}
                target="_blank"
                rel="noreferrer"
                aria-label="Open PDF in new tab"
                title="Open PDF in new tab"
              >
                <ExternalLink size={14} />
              </a>
            </div>
          </div>

          <div className="pdf-cite-bar">
            <input
              type="text"
              value={quoteDraft}
              onChange={(e) => setQuoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  citeCurrentPage();
                }
              }}
              placeholder={`Optional excerpt or takeaway from p.${current.current_page}…`}
              aria-label="PDF citation quote"
            />
          </div>
        </div>
      ) : (
        <div
          className="pdf-dropzone"
          onClick={() => noteId && fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
        >
          <FileText size={26} />
          <p className="pdf-drop-title">Drop a PDF paper, slide deck, or chapter here</p>
          <p className="pdf-drop-sub">
            Read alongside your note and insert clickable <code>📄 p.N</code> citations.
          </p>
        </div>
      )}

      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}

      <div className="video-scroll" aria-busy={loading}>
        {pdfs.length === 0 && !loading && (
          <div className="empty-videos">
            <BookOpenCheck size={20} />
            <p>Attach research papers, problem sets, or lecture slides to study side-by-side.</p>
          </div>
        )}
        <ul className="video-list">
          {pdfs.map((p) => {
            const pct =
              p.status === "done"
                ? 100
                : p.page_count > 1
                  ? Math.min(100, Math.round((p.current_page / p.page_count) * 100))
                  : p.status === "reading"
                    ? 50
                    : 0;
            const statusLabel =
              p.status === "done"
                ? "done"
                : p.status === "reading"
                  ? `reading · p.${p.current_page}/${p.page_count}`
                  : `${p.page_count} ${p.page_count === 1 ? "page" : "pages"} · ${formatBytes(p.byte_size)}`;
            return (
              <li
                key={p.id}
                className="video-row pdf-row"
                data-active={p.id === selectedId}
                data-status={p.status === "done" ? "done" : p.status === "reading" ? "in_progress" : "unwatched"}
              >
                <button
                  type="button"
                  className="video-main pdf-row-main"
                  onClick={() => setSelectedId(p.id)}
                  aria-label={`Open PDF ${p.title}`}
                >
                  <span className="pdf-badge" aria-hidden="true">
                    PDF
                  </span>
                  <span className="video-text">
                    <span className="video-title">
                      <span className="strike">{p.title}</span>
                    </span>
                    <span className="video-status">{statusLabel}</span>
                  </span>
                </button>
                <div className="video-actions">
                  <button
                    type="button"
                    className={`icon-btn sm ${p.status === "done" ? "is-on" : ""}`}
                    onClick={() => void toggleDone(p)}
                    aria-pressed={p.status === "done"}
                    aria-label={p.status === "done" ? "Mark PDF as unread" : "Mark PDF as done"}
                    title={p.status === "done" ? "Undo done" : "Mark done"}
                  >
                    <Check size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn sm danger"
                    onClick={() => void removePdf(p)}
                    aria-label={`Delete ${p.title}`}
                    title="Remove PDF"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <span className="bar" aria-hidden="true">
                  <span style={{ width: `${pct}%` }} />
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
});
