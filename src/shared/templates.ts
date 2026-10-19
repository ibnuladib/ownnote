import type { TemplateMeta, TipTapJSON } from "./types";

export const TEMPLATES: TemplateMeta[] = [
  {
    key: "learning_journey",
    name: "Learning journey",
    description: "Checkpoints + space for notes; pair with the YouTube panel.",
  },
];

export function learningJourneyContent(title: string): TipTapJSON {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: title }],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Track what you need to learn. Tick checkpoints as you go.",
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Checkpoints" }],
      },
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Define the goal" }],
              },
            ],
          },
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Watch core videos" }],
              },
            ],
          },
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Build a small project" }],
              },
            ],
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Notes" }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "" }],
      },
    ],
  };
}

export function contentForTemplate(key: string, title: string): TipTapJSON | null {
  if (key === "learning_journey") return learningJourneyContent(title);
  return null;
}
