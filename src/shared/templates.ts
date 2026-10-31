import type { TemplateMeta, TipTapJSON } from "./types";

export const TEMPLATES: TemplateMeta[] = [
  {
    key: "learning_journey",
    name: "Learning journey",
    description: "Checkpoints + space for notes; pair with the YouTube panel.",
  },
  {
    key: "cornell_notes",
    name: "Cornell lecture notes",
    description: "Key questions, structured lecture notes, active recall cues, and summary.",
  },
  {
    key: "paper_review",
    name: "Research paper deep-dive",
    description: "Thesis, methodology, key results, limitations, and PDF page citations.",
  },
  {
    key: "system_design",
    name: "System design & architecture",
    description: "Constraints, back-of-the-envelope math, data model, and tradeoffs.",
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
      { type: "paragraph" },
    ],
  };
}

export function cornellNotesContent(title: string): TipTapJSON {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: title }],
      },
      {
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Core Objective: What single mental model or skill should I walk away with from this session?",
              },
            ],
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Key Questions & Recall Cues" }],
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
                content: [{ type: "text", text: "Why does this mechanism work from first principles?" }],
              },
            ],
          },
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Where does the naive approach break down?" }],
              },
            ],
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Lecture & Reading Notes" }],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Capture timestamps, PDF citations, derivations, and examples here.",
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "3-Sentence Synthesis" }],
      },
      { type: "paragraph" },
    ],
  };
}

export function paperReviewContent(title: string): TipTapJSON {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: title }],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "1. Problem & Core Thesis" }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "What bottleneck or open question does this paper address?" }],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "2. Key Contributions" }],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Contribution 1:" }] }],
          },
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Contribution 2:" }] }],
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "3. Methodology & Architecture" }],
      },
      { type: "paragraph" },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "4. Assumptions, Failure Modes & Open Questions" }],
      },
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Verify baseline comparison on main benchmark" }] }],
          },
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Check ablation study for key hyperparameters" }] }],
          },
        ],
      },
    ],
  };
}

export function systemDesignContent(title: string): TipTapJSON {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: title }],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "1. Requirements & SLOs" }],
      },
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Functional requirements defined" }] }],
          },
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Latency, throughput, and durability targets" }] }],
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "2. Back-of-the-Envelope Estimates" }],
      },
      {
        type: "codeBlock",
        attrs: { language: "text" },
        content: [
          {
            type: "text",
            text: "QPS: \nPeak QPS: \nStorage / day: \nBandwidth: ",
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "3. Data Model & API Surface" }],
      },
      { type: "paragraph" },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "4. Bottlenecks & Failure Recovery" }],
      },
      { type: "paragraph" },
    ],
  };
}

export function contentForTemplate(key: string, title: string): TipTapJSON | null {
  if (key === "learning_journey") return learningJourneyContent(title);
  if (key === "cornell_notes") return cornellNotesContent(title);
  if (key === "paper_review") return paperReviewContent(title);
  if (key === "system_design") return systemDesignContent(title);
  return null;
}
