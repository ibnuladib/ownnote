import { useEffect, useMemo, useState } from "react";
import { Brain, CheckCircle2, RotateCcw, Sparkles, X } from "lucide-react";
import type { Note, TipTapJSON } from "@shared/types";

export type StudyCard = {
  id: string;
  kind: "cloze" | "highlight" | "qa" | "checkpoint";
  prompt: string;
  answer: string;
  context?: string;
};

type TipNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: TipNode[];
};

function plainText(nodes: TipNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((n) => {
      if (typeof n.text === "string") return n.text;
      if (n.type === "timestampChip") return `[${n.attrs?.label ?? "00:00"}]`;
      if (n.type === "pdfAnchor") return `[${n.attrs?.label ?? "p.1"}]`;
      return plainText(n.content);
    })
    .join("");
}

/**
 * Extracts active-recall study cards from a TipTap document:
 * 1. Explicit `cloze` marks (`{{answer}}` or Ctrl+Shift+K)
 * 2. Highlighted key terms (`==term==` or Ctrl+Shift+H)
 * 3. `Q: ... / A: ...` or `Question? -> Answer` lines
 * 4. Task-list checkpoints under section headings
 */
export function extractStudyCards(doc: TipTapJSON, noteTitle: string): StudyCard[] {
  const cards: StudyCard[] = [];
  const root = doc as TipNode;
  if (!root || !Array.isArray(root.content)) return cards;

  let currentHeading = noteTitle || "Note";
  let seq = 0;

  const walkBlock = (node: TipNode) => {
    if (!node || typeof node !== "object") return;

    if (node.type === "heading") {
      const h = plainText(node.content).trim();
      if (h) currentHeading = h;
      return;
    }

    if (node.type === "paragraph") {
      const inlines = node.content ?? [];
      const full = plainText(inlines).trim();
      if (!full) return;

      // 1. Check for cloze or highlight marks inside this paragraph
      for (const child of inlines) {
        if (!child.text || !child.marks?.length) continue;
        const isCloze = child.marks.some((m) => m.type === "cloze");
        const isHighlight = child.marks.some((m) => m.type === "highlight");
        if (!isCloze && !isHighlight) continue;

        const target = child.text.trim();
        if (target.length < 2 || target.length === full.length) continue;

        const masked = full.replace(target, "[ … ]");
        cards.push({
          id: `card-${++seq}`,
          kind: isCloze ? "cloze" : "highlight",
          prompt: masked,
          answer: target,
          context: currentHeading,
        });
      }

      // 2. Check for Q&A syntax: "Q: ... A: ..." or "Question? :: Answer" or "Term — Definition"
      const qaMatch =
        full.match(/^Q:\s*(.+?)\s+A:\s*(.+)$/i) ||
        full.match(/^(.+\?)\s*(?:—|--|->|::)\s*(.+)$/);
      if (qaMatch) {
        cards.push({
          id: `card-${++seq}`,
          kind: "qa",
          prompt: qaMatch[1]!.trim(),
          answer: qaMatch[2]!.trim(),
          context: currentHeading,
        });
      }
      return;
    }

    if (node.type === "taskItem") {
      const text = plainText(node.content).trim();
      if (text.length > 5) {
        const parts = text.split(/\s*(?:—|--|->|:)\s*/);
        if (parts.length >= 2 && parts[0]!.length > 2 && parts[1]!.length > 2) {
          cards.push({
            id: `card-${++seq}`,
            kind: "checkpoint",
            prompt: parts[0]!.trim(),
            answer: parts.slice(1).join(" — ").trim(),
            context: currentHeading,
          });
        }
      }
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) walkBlock(child);
    }
  };

  for (const block of root.content) {
    walkBlock(block);
  }

  return cards;
}

type Props = {
  note: Note;
  onClose: () => void;
};

export function StudyModal({ note, onClose }: Props) {
  const allCards = useMemo(
    () => extractStudyCards(note.content, note.title),
    [note.content, note.title],
  );

  const [queue, setQueue] = useState<StudyCard[]>(() => allCards);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [mastered, setMastered] = useState(0);
  const [reviewed, setReviewed] = useState(0);

  const current = queue[idx] ?? null;
  const finished = queue.length > 0 && idx >= queue.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (!current || finished) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!revealed) setRevealed(true);
        else grade("good");
      } else if (revealed && e.key === "1") {
        e.preventDefault();
        grade("again");
      } else if (revealed && (e.key === "2" || e.key === "3")) {
        e.preventDefault();
        grade("good");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function grade(outcome: "again" | "good") {
    if (!current) return;
    setReviewed((r) => r + 1);
    setRevealed(false);
    if (outcome === "again") {
      // Re-append card to the end of the session queue until mastered
      setQueue((q) => [...q, current]);
      setIdx((i) => i + 1);
    } else {
      setMastered((m) => m + 1);
      setIdx((i) => i + 1);
    }
  }

  function restart() {
    setQueue(allCards);
    setIdx(0);
    setRevealed(false);
    setMastered(0);
    setReviewed(0);
  }

  const totalUnique = allCards.length;
  const pct = totalUnique > 0 ? Math.min(100, Math.round((mastered / totalUnique) * 100)) : 0;

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div
        className="palette study-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Active recall study deck"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="study-head">
          <div className="study-head-title">
            <Brain size={18} />
            <div>
              <h2>Active Recall</h2>
              <p>{note.title || "Untitled"}</p>
            </div>
          </div>
          <div className="study-head-right">
            {totalUnique > 0 && (
              <span className="count">
                {mastered}/{totalUnique} mastered
              </span>
            )}
            <button type="button" className="icon-btn sm" onClick={onClose} aria-label="Close study modal">
              <X size={16} />
            </button>
          </div>
        </header>

        {totalUnique > 0 && (
          <div className="study-progress" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </div>
        )}

        <div className="study-body">
          {totalUnique === 0 ? (
            <div className="study-empty">
              <Sparkles size={26} />
              <h3>Turn your note into instant flashcards</h3>
              <p>
                Wrap key terms in <code>{"{{double braces}}"}</code> (or select text and press{" "}
                <kbd>Ctrl+Shift+K</kbd>), highlight terms with <kbd>Ctrl+Shift+H</kbd>, or write{" "}
                <code>Question? — Answer</code> lines.
              </p>
            </div>
          ) : finished ? (
            <div className="study-done">
              <CheckCircle2 size={34} />
              <h3>Session complete!</h3>
              <p>
                Mastered <b>{mastered}</b> {mastered === 1 ? "card" : "cards"} in <b>{reviewed}</b>{" "}
                {reviewed === 1 ? "review" : "reviews"}.
              </p>
              <div className="study-done-actions">
                <button type="button" className="btn-primary" onClick={restart}>
                  <RotateCcw size={15} />
                  <span>Practice again</span>
                </button>
                <button type="button" className="top-btn" onClick={onClose}>
                  Back to note
                </button>
              </div>
            </div>
          ) : current ? (
            <div className="study-card">
              <div className="study-card-meta">
                <span className="study-badge" data-kind={current.kind}>
                  {current.kind === "cloze"
                    ? "Cloze deletion"
                    : current.kind === "highlight"
                      ? "Key concept"
                      : current.kind === "qa"
                        ? "Q & A"
                        : "Checkpoint"}
                </span>
                {current.context && <span className="study-context">{current.context}</span>}
              </div>

              <div className="study-prompt">{current.prompt}</div>

              {revealed ? (
                <div className="study-answer-wrap">
                  <div className="study-answer-label">Answer</div>
                  <div className="study-answer">{current.answer}</div>
                </div>
              ) : (
                <button
                  type="button"
                  className="study-reveal-btn"
                  onClick={() => setRevealed(true)}
                >
                  <span>Show answer</span>
                  <kbd>Space</kbd>
                </button>
              )}

              {revealed && (
                <div className="study-grade-row">
                  <button
                    type="button"
                    className="study-grade again"
                    onClick={() => grade("again")}
                  >
                    <span>Again</span>
                    <kbd>1</kbd>
                  </button>
                  <button
                    type="button"
                    className="study-grade good"
                    onClick={() => grade("good")}
                  >
                    <span>Got it</span>
                    <kbd>Space</kbd>
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
