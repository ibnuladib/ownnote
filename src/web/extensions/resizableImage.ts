import Image from "@tiptap/extension-image";
import type { Editor } from "@tiptap/core";

const MIN_W = 80;
const MAX_W_RATIO = 1;

function clampWidth(px: number, container: number): number {
  const max = Math.max(MIN_W, Math.floor(container * MAX_W_RATIO));
  return Math.min(max, Math.max(MIN_W, Math.round(px)));
}

/**
 * Block image with corner resize + native TipTap drag (NodeSelection).
 * Persists `width` (px) on the node so it survives save/reload.
 */
export const ResizableImage = Image.extend({
  name: "image",
  draggable: true,

  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null as number | null,
        parseHTML: (el) => {
          const attr = el.getAttribute("width");
          if (attr && /^\d+$/.test(attr)) return Number(attr);
          const style = (el as HTMLElement).style?.width;
          if (style?.endsWith("px")) return parseInt(style, 10) || null;
          return null;
        },
        renderHTML: (attrs) => {
          if (!attrs.width) return {};
          return {
            width: String(attrs.width),
            style: `width: ${attrs.width}px; height: auto;`,
          };
        },
      },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let attrs = node.attrs as {
        src: string;
        alt: string;
        width: number | null;
      };

      const dom = document.createElement("div");
      dom.className = "editor-image";
      dom.draggable = true;

      const img = document.createElement("img");
      img.src = attrs.src ?? "";
      img.alt = attrs.alt ?? "";
      img.draggable = false;

      const handle = document.createElement("span");
      handle.className = "editor-image-handle";
      handle.contentEditable = "false";
      handle.title = "Drag to resize";
      handle.setAttribute("aria-label", "Resize image");

      dom.append(img, handle);

      const applyWidth = (w: number | null) => {
        if (w) {
          img.style.width = `${w}px`;
          img.style.height = "auto";
          dom.style.width = `${w}px`;
        } else {
          img.style.width = "";
          img.style.height = "";
          dom.style.width = "";
        }
      };
      applyWidth(attrs.width);

      let resizing = false;

      const onPointerDown = (e: PointerEvent) => {
        if (!editor.isEditable) return;
        e.preventDefault();
        e.stopPropagation();
        resizing = true;
        handle.setPointerCapture(e.pointerId);
        dom.classList.add("is-resizing");

        const startX = e.clientX;
        const startW = img.getBoundingClientRect().width;
        const container =
          dom.closest(".prose")?.clientWidth ??
          dom.parentElement?.clientWidth ??
          startW;

        const onMove = (ev: PointerEvent) => {
          if (!resizing) return;
          const next = clampWidth(startW + (ev.clientX - startX), container);
          applyWidth(next);
        };

        const onUp = (ev: PointerEvent) => {
          if (!resizing) return;
          resizing = false;
          dom.classList.remove("is-resizing");
          try {
            handle.releasePointerCapture(ev.pointerId);
          } catch {
            /* already released */
          }
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);

          const finalW = clampWidth(img.getBoundingClientRect().width, container);
          const pos = typeof getPos === "function" ? getPos() : null;
          if (typeof pos !== "number") return;
          attrs = { ...attrs, width: finalW };
          editor
            .chain()
            .focus()
            .command(({ tr }) => {
              tr.setNodeMarkup(pos, undefined, { ...attrs });
              return true;
            })
            .run();
        };

        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      };

      handle.addEventListener("pointerdown", onPointerDown);

      // Select node on click (enables drag-to-move via ProseMirror).
      const onClick = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest(".editor-image-handle")) return;
        const pos = typeof getPos === "function" ? getPos() : null;
        if (typeof pos !== "number") return;
        editor.commands.setNodeSelection(pos);
      };
      dom.addEventListener("click", onClick);

      return {
        dom,
        ignoreMutation: () => true,
        selectNode: () => {
          dom.classList.add("is-selected");
        },
        deselectNode: () => {
          dom.classList.remove("is-selected");
        },
        update: (updated) => {
          if (updated.type.name !== "image") return false;
          attrs = updated.attrs as typeof attrs;
          if (attrs.src !== img.getAttribute("src")) img.src = attrs.src ?? "";
          if (attrs.alt !== img.alt) img.alt = attrs.alt ?? "";
          applyWidth(attrs.width ?? null);
          return true;
        },
        destroy: () => {
          handle.removeEventListener("pointerdown", onPointerDown);
          dom.removeEventListener("click", onClick);
        },
      };
    };
  },
});

/** Ensure insert path always uses the image node (width starts unset = natural). */
export function insertEditorImage(editor: Editor, src: string, alt = "image") {
  return editor
    .chain()
    .focus()
    .insertContent({
      type: "image",
      attrs: { src, alt, width: null },
    })
    .run();
}
