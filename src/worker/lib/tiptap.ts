import type { TipTapJSON } from "../../shared/types";

type Node = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: Node[];
};

export const EMPTY_DOC: TipTapJSON = { type: "doc", content: [{ type: "paragraph" }] };

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "listItem",
  "taskItem",
  "bulletList",
  "orderedList",
  "taskList",
]);

/** Plain text of a TipTap doc (for search). */
export function extractText(doc: unknown): string {
  const out: string[] = [];
  const walk = (n: Node, depth: number) => {
    if (depth > 100 || !n || typeof n !== "object") return;
    if (typeof n.text === "string") out.push(n.text);
    if (Array.isArray(n.content)) for (const c of n.content) walk(c, depth + 1);
    if (n.type && BLOCK_TYPES.has(n.type)) out.push("\n");
    else if (n.type === "hardBreak") out.push("\n");
  };
  walk(doc as Node, 0);
  return out.join("").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

function renderInline(nodes: Node[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((n) => {
      if (n.type === "hardBreak") return "  \n";
      let t = n.text ?? "";
      if (!t) return renderInline(n.content);
      for (const m of n.marks ?? []) {
        if (m.type === "code") t = "`" + t + "`";
        else if (m.type === "bold") t = `**${t}**`;
        else if (m.type === "italic") t = `*${t}*`;
        else if (m.type === "strike") t = `~~${t}~~`;
        else if (m.type === "link" && typeof m.attrs?.href === "string") t = `[${t}](${m.attrs.href})`;
      }
      return t;
    })
    .join("");
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l, i) => (i === 0 || !l ? l : pad + l))
    .join("\n");
}

function renderBlock(n: Node, depth = 0): string {
  if (depth > 50) return "";
  const kids = n.content ?? [];
  switch (n.type) {
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 1));
      return `${"#".repeat(level)} ${renderInline(kids)}`;
    }
    case "paragraph":
      return renderInline(kids);
    case "blockquote":
      return renderBlocks(kids, depth + 1)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "codeBlock":
      return "```" + String(n.attrs?.language ?? "") + "\n" + kids.map((k) => k.text ?? "").join("") + "\n```";
    case "horizontalRule":
      return "---";
    case "bulletList":
      return kids.map((li) => "- " + indent(renderBlocks(li.content ?? [], depth + 1, "\n"), "  ")).join("\n");
    case "orderedList": {
      const start = Number(n.attrs?.start) || 1;
      return kids
        .map((li, i) => `${start + i}. ` + indent(renderBlocks(li.content ?? [], depth + 1, "\n"), "   "))
        .join("\n");
    }
    case "taskList":
      return kids
        .map(
          (li) =>
            `- [${li.attrs?.checked ? "x" : " "}] ` + indent(renderBlocks(li.content ?? [], depth + 1, "\n"), "  "),
        )
        .join("\n");
    default:
      return kids.length ? renderBlocks(kids, depth + 1) : renderInline([n]);
  }
}

function renderBlocks(nodes: Node[], depth = 0, sep = "\n\n"): string {
  return nodes
    .map((n) => renderBlock(n, depth))
    .filter((s) => s !== "")
    .join(sep);
}

export function toMarkdown(doc: unknown): string {
  const root = doc as Node;
  if (!root || typeof root !== "object" || !Array.isArray(root.content)) return "";
  return renderBlocks(root.content);
}
