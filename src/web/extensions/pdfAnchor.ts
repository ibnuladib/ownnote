import { Node, mergeAttributes } from "@tiptap/core";

export type PdfAnchorAttrs = {
  pdfId: string;
  page: number;
  label: string | null;
  quote: string | null;
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pdfAnchor: {
      insertPdfAnchor: (attrs: {
        pdfId: string;
        page: number;
        label?: string;
        quote?: string;
      }) => ReturnType;
    };
  }
}

export const PdfAnchor = Node.create({
  name: "pdfAnchor",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      pdfId: { default: "" },
      page: { default: 1 },
      label: { default: null },
      quote: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-pdf-anchor]",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const pdfId = el.getAttribute("data-pdf-id") || "";
          const page = Math.max(1, Number(el.getAttribute("data-page") || 1));
          if (!pdfId) return false;
          return {
            pdfId,
            page,
            label: el.getAttribute("data-label"),
            quote: el.getAttribute("data-quote"),
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const page = Math.max(1, Math.floor(Number(node.attrs.page) || 1));
    const rawLabel = typeof node.attrs.label === "string" && node.attrs.label.trim() ? node.attrs.label.trim() : `p.${page}`;
    const quote = typeof node.attrs.quote === "string" && node.attrs.quote.trim() ? node.attrs.quote.trim() : "";
    const shortQuote = quote.length > 42 ? `${quote.slice(0, 40)}…` : quote;
    const text = shortQuote ? `📄 ${rawLabel} · “${shortQuote}”` : `📄 ${rawLabel}`;

    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-pdf-anchor": "",
        "data-pdf-id": node.attrs.pdfId,
        "data-page": String(page),
        "data-label": rawLabel,
        "data-quote": quote || undefined,
        class: "pdf-chip",
        title: quote ? `${rawLabel}: "${quote}" — click to open PDF page ${page}` : `Open PDF at page ${page}`,
        contenteditable: "false",
      }),
      text,
    ];
  },

  addCommands() {
    return {
      insertPdfAnchor:
        (attrs) =>
        ({ commands }) => {
          const page = Math.max(1, Math.floor(attrs.page || 1));
          return commands.insertContent({
            type: this.name,
            attrs: {
              pdfId: attrs.pdfId,
              page,
              label: attrs.label ?? `p.${page}`,
              quote: attrs.quote ? attrs.quote.trim().slice(0, 280) : null,
            },
          });
        },
    };
  },
});
