import { Mark, markInputRule, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    cloze: {
      toggleCloze: () => ReturnType;
      setCloze: () => ReturnType;
      unsetCloze: () => ReturnType;
    };
  }
}

/** Matches `{{answer}}` as you type and turns it into an active-recall Cloze mark. */
const CLOZE_INPUT_REGEX = /(?:\{\{)([^}]+)(?:\}\})$/;

export const ClozeMark = Mark.create({
  name: "cloze",

  parseHTML() {
    return [
      { tag: "span[data-cloze]" },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-cloze": "",
        class: "cloze-mark",
        title: "Active recall cloze (click in Recall mode to reveal)",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCloze:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleCloze:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetCloze:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-k": () => this.editor.commands.toggleCloze(),
    };
  },

  addInputRules() {
    return [
      markInputRule({
        find: CLOZE_INPUT_REGEX,
        type: this.type,
      }),
    ];
  },
});
