import { Extension } from "@tiptap/react";

/** Adds a `fontSize` attribute to the textStyle mark (requires @tiptap/extension-text-style). */
export const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el: HTMLElement) => el.style.fontSize || null,
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {},
          },
        },
      },
    ];
  },
});

export const FONT_SIZES = ["13px", "15px", "18px", "22px", "28px", "36px"];
