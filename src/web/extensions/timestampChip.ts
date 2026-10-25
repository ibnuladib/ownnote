import { Node, mergeAttributes } from "@tiptap/core";
import { formatClock } from "../lib/time";

export type TimestampChipAttrs = {
  youtubeId: string;
  seconds: number;
  label: string | null;
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    timestampChip: {
      insertTimestampChip: (attrs: { youtubeId: string; seconds: number; label?: string }) => ReturnType;
    };
  }
}

export const TimestampChip = Node.create({
  name: "timestampChip",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      youtubeId: { default: "" },
      seconds: { default: 0 },
      label: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-timestamp-chip]',
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const youtubeId = el.getAttribute("data-youtube-id") || "";
          const seconds = Number(el.getAttribute("data-seconds") || 0);
          if (!youtubeId) return false;
          return {
            youtubeId,
            seconds,
            label: el.getAttribute("data-label"),
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const seconds = Number(node.attrs.seconds) || 0;
    const label =
      (typeof node.attrs.label === "string" && node.attrs.label) || formatClock(seconds);
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-timestamp-chip": "",
        "data-youtube-id": node.attrs.youtubeId,
        "data-seconds": String(seconds),
        "data-label": label,
        class: "timestamp-chip",
        contenteditable: "false",
      }),
      label,
    ];
  },

  addCommands() {
    return {
      insertTimestampChip:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              youtubeId: attrs.youtubeId,
              seconds: Math.max(0, Math.floor(attrs.seconds)),
              label: attrs.label ?? formatClock(attrs.seconds),
            },
          }),
    };
  },
});
