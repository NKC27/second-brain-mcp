export interface Template {
  id: string;
  name: string;
  description: string;
  tags: string[];
  body: string;
  source: "built-in" | "custom";
}

/** Placeholders the server fills itself; everything else is a field the caller can supply. */
const RESERVED = new Set(["title", "date"]);

export const BUILT_IN_TEMPLATES: Template[] = [
  {
    id: "meeting",
    name: "Meeting notes",
    description: "Attendees, purpose, decisions and action items for a meeting or call.",
    tags: ["meeting"],
    source: "built-in",
    body: `**Date:** {{date}}
**Attendees:** {{attendees}}
**Purpose:** {{purpose}}

## Notes

## Decisions

## Action items
- [ ]

## Follow-ups
`,
  },
  {
    id: "decision",
    name: "Decision record",
    description: "Context, options, the decision and its consequences, so future you knows why.",
    tags: ["decision"],
    source: "built-in",
    body: `**Status:** {{status}}
**Date:** {{date}}
**Deciders:** {{deciders}}

## Context
{{context}}

## Options considered
-

## Decision
{{decision}}

## Consequences
- Good:
- Risks:

## Revisit when
`,
  },
  {
    id: "project",
    name: "Project hub",
    description: "A home page for a project: goal, milestones, next actions and a running log.",
    tags: ["project"],
    source: "built-in",
    body: `**Goal:** {{goal}}
**Status:** active
**Started:** {{date}}

## Why it matters

## Milestones
- [ ]

## Next actions
- [ ]

## Notes and links

## Log
- {{date}}: project created
`,
  },
  {
    id: "reading",
    name: "Reading notes",
    description: "Capture a book, article or talk: summary, key ideas, quotes and what to do with it.",
    tags: ["reading"],
    source: "built-in",
    body: `**Author / source:** {{author}}
**Read on:** {{date}}

## One-sentence summary
{{summary}}

## Key ideas
-

## Quotes worth keeping
>

## How this connects to what I already know
Link related notes with [[wiki links]].

## What I'll do with it
- [ ]
`,
  },
  {
    id: "person",
    name: "Person",
    description: "A lightweight contact note: who they are, what matters to them, conversations and follow-ups.",
    tags: ["person"],
    source: "built-in",
    body: `**Role / org:** {{role}}
**How we met:** {{context}}
**Last contact:** {{date}}

## What matters to them

## Conversations
- {{date}}:

## Follow-ups
- [ ]
`,
  },
  {
    id: "idea",
    name: "Idea",
    description: "Park an idea with why it matters and what would make it real.",
    tags: ["idea"],
    source: "built-in",
    body: `## The idea
{{idea}}

## Why now

## What would make it real
- [ ]

## Related
`,
  },
  {
    id: "how-to",
    name: "How-to / runbook",
    description: "Repeatable steps for something you will need to do again.",
    tags: ["how-to"],
    source: "built-in",
    body: `**Goal:** {{goal}}
**Last verified:** {{date}}

## Before you start

## Steps
1.

## Check it worked

## Gotchas
`,
  },
  {
    id: "weekly-review",
    name: "Weekly review",
    description: "Wins, lessons, open loops and the top three priorities for next week.",
    tags: ["review"],
    source: "built-in",
    body: `**Week of:** {{date}}

## Wins

## What I learned

## Open loops
- [ ]

## Top three for next week
1.
2.
3.
`,
  },
];

/** Every `{{field}}` a caller may fill, excluding the ones the server fills itself. */
export function templateFields(template: Template): string[] {
  const found = new Set<string>();
  for (const m of template.body.matchAll(/\{\{\s*([a-zA-Z][\w-]*)\s*\}\}/g)) {
    if (!RESERVED.has(m[1]!)) found.add(m[1]!);
  }
  return [...found];
}

export interface Rendered {
  body: string;
  /** Fields that had no value and were left as a visible `_TBD_` marker. */
  missing: string[];
}

export function renderTemplate(
  template: Template,
  values: { title: string; date: string; fields?: Record<string, string> }
): Rendered {
  const supplied = values.fields ?? {};
  const missing = new Set<string>();
  const body = template.body.replace(/\{\{\s*([a-zA-Z][\w-]*)\s*\}\}/g, (_match, key: string) => {
    if (key === "title") return values.title;
    if (key === "date") return values.date;
    const value = supplied[key]?.trim();
    if (value) return value;
    missing.add(key);
    return "_TBD_";
  });
  return { body: body.trimEnd(), missing: [...missing] };
}
