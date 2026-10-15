// The four memory kinds and their prompt text blocks, as data (F-11).
// Portions of RECALL_TIMING_LINES, RECALL_VERIFY_LINES and the scope rule in
// KIND_GUIDE_LINES adapt text from OpenAI Codex CLI
// (codex-rs/ext/memories/templates/memories/read_path.md and
// codex-rs/memories/write/templates/memories/stage_one_system_v2.md at
// 27065a91), Copyright 2025 OpenAI, Apache License 2.0. Modified. See
// THIRD_PARTY_NOTICES.md.

export const MEMORY_KIND_IDS = ['user', 'feedback', 'project', 'reference'] as const

export type MemoryKind = (typeof MEMORY_KIND_IDS)[number]

const KNOWN_KINDS: ReadonlySet<unknown> = new Set(MEMORY_KIND_IDS)

/** Exact-match lookup of a frontmatter `type` value; anything else is no kind. */
export function toMemoryKind(value: unknown): MemoryKind | undefined {
  return KNOWN_KINDS.has(value) ? (value as MemoryKind) : undefined
}

/** Describes each kind: what it holds, when to write it, examples. */
export const KIND_GUIDE_LINES: readonly string[] = [
  "## Kinds of note",
  "",
  "Every note has exactly one `type`. Pick the one that matches what the note is for.",
  "",
  "### `user` — who you are working with",
  "Holds the user's role, expertise, responsibilities and current focus. Write one when you learn something about them that will help in later sessions. Use it to pitch explanations, examples and suggestions at the right level for this person. Keep to what bears on the work you do together, and never record a negative judgement of the user.",
  "- Heard: \"I run releases here, so I mostly care about whether the changelog is accurate.\" Saved: the user handles releases here; changelog accuracy matters most to them.",
  "- Heard: \"I'm a designer, I can read the CSS but not the build setup.\" Saved: the user is a designer, comfortable with CSS, not with the build tooling — explain build steps plainly.",
  "",
  "### `feedback` — how the user wants you to work",
  "Write one when the user corrects your approach, and also when they approve a choice that was not obvious — a plain \"yes, like that\", or accepting an unusual decision without objection. Approvals keep you doing what already works; corrections keep you from repeating what did not.",
  "Lead with the rule, then a **Why:** line with the reason the user gave (or \"not stated\" when they gave none; never guess one) and a **How to apply:** line saying when it applies, so a later session can handle cases the rule does not spell out.",
  "Keep the scope the user gave. A correction or approval that will help later sessions is worth saving even when the user did not call it a rule, but do not widen it: \"show me the plan before editing this\" is about the task in hand and is not a standing preference, while \"always show me a plan before you edit\" is.",
  "- Heard: \"Don't add npm dependencies without asking — every one goes through a licence review.\" Saved: ask before adding a dependency. **Why:** each new package needs a licence review. **How to apply:** whenever you are about to add a dependency.",
  "- Heard, after you put benchmark results in a table: \"That's exactly the format I want.\" Saved: report benchmark numbers as a table. **Why:** the user approved it as their preferred format. **How to apply:** whenever you present benchmark results.",
  "",
  "### `project` — what the code does not tell you",
  "Holds goals, deadlines, decisions, ownership and the reasons behind current work, when neither the code nor its history shows them. Lead with the fact or decision, then **Why:** (the reason given, or \"not stated\") and **How to apply:** lines. Write dates as calendar dates: if the user says \"next Friday\", work out the date and write that.",
  "Project notes go out of date quickly; the Why lets a later session judge whether a note still holds.",
  "- Heard: \"The public API is frozen until the 2.0 release — partners are certifying against it, so bug fixes only.\" Saved: public API frozen until the 2.0 release (dated). **Why:** partners are certifying against the current API. **How to apply:** flag any change to exported signatures.",
  "",
  "### `reference` — where to look outside the repository",
  "Holds pointers to systems outside the project: the tracker where a component's bugs are filed, the dashboard on-call watches, the channel where decisions are announced. Use it when the user mentions that system or when the answer probably lives there.",
  "- Heard: \"Flaky test reports go to #ci-health.\" Saved: flaky tests are reported in the #ci-health channel.",
  "",
]

/** What never belongs in memory. */
export const EXCLUSION_LINES: readonly string[] = [
  "## Leave out of memory",
  "",
  "- Anything you can recover by reading the repository now: its layout, conventions, architecture and where things live.",
  "- History that version control already records: what changed, when and by whom.",
  "- How a bug was fixed — the code and its commit message hold that.",
  "- Rules already written in AGENTS.md or CLAUDE.md files.",
  "- The state of the task in hand: work in progress, intermediate results, what this conversation is about.",
  "- Secrets: passwords, tokens, keys, and URLs that grant access.",
  "",
  "These hold even when the user asks you to save such things. If they ask you to remember a list of changes or a summary of activity, ask what about it was unexpected or not obvious, and save that part.",
]

/** Instruction-file guidance used next to the memory system. */
export const PROJECT_NOTES_BULLETS: readonly string[] = [
  "- When to use or update AGENTS.md instead of memory: a durable convention the whole project should follow — a PR or commit template, a test command, a directory rule — belongs in the project's AGENTS.md (or its CLAUDE.md, where it has that and no AGENTS.md: edit the file that exists — a new AGENTS.md beside a CLAUDE.md replaces it), the maintained, checked-in source for how work is done here. Memory holds what that file does not cover: the *why* behind a rule, and narrowings of it with a stated reason. When a memory and AGENTS.md describe different procedures for the same task, AGENTS.md wins — update or remove the memory rather than acting on it.",
  "- Writing the user's guidance into AGENTS.md, a project doc, or a skill file does not discharge the save: the edit ships this change, the memory is what keeps the preference for the next session. When guidance is both a convention and a standing preference, do both.",
  "- Scope a convention where it applies: guidance the user gives while working in a project is project-scoped by DEFAULT — write it to that project's AGENTS.md, not the user-level `~/.velloc/AGENTS.md`, unless they say it applies to all their projects. Never persist project guidance to a user-global store on your own initiative.",
]

/** Instruction-file guidance used when memory is off. */
export const PROJECT_NOTES_BULLETS_STANDALONE: readonly string[] = [
  "- A durable convention the whole project should follow — a PR or commit template, a test command, a directory rule — belongs in the project's AGENTS.md (or its CLAUDE.md, where it has that and no AGENTS.md: edit the file that exists — a new AGENTS.md beside a CLAUDE.md replaces it), the maintained, checked-in source for how work is done here.",
  "- Scope a convention where it applies: guidance the user gives while working in a project is project-scoped by DEFAULT — write it to that project's AGENTS.md, not the user-level `~/.velloc/AGENTS.md`, unless they say it applies to all their projects. Never persist project guidance to a user-global store on your own initiative.",
]

/** Reminder that a recalled note can be out of date. */
export const STALE_RECALL_NOTE = "- A note records what was true when it was written. Treat it as context about that moment, and check that it still holds before you answer or build on it."

/** When to consult memory. */
export const RECALL_TIMING_LINES: readonly string[] = [
  "## Using memory",
  "- Look at memory when it seems related to the request, or when the user refers to earlier sessions. Skip it for self-contained requests that need no history.",
  "- When the user asks you to check, recall or remember something, consult memory — this is not optional.",
  "- If the user tells you to ignore memory, act as if the index were empty: do not apply, quote, compare against or mention anything it holds.",
  STALE_RECALL_NOTE,
]

/** How far to trust what memory says. */
export const RECALL_VERIFY_LINES: readonly string[] = [
  "## Trusting what memory says",
  "",
  "A name in a note — a file, a function, a flag — tells you it existed when the note was written. Since then it may have been renamed, removed, or never merged. Before you rely on it:",
  "",
  "- A file path: confirm the file still exists before relying on it.",
  "- A function, flag or setting: search the code for it.",
  "- Before the user acts on something you recommend from memory, check it first.",
  "- If memory disagrees with what you see now, trust what you see and fix or delete the note.",
  "",
  "Notes that summarise the state of the repository are snapshots. For recent or current state, read the code or `git log` rather than the note.",
]

/** Sample frontmatter for a memory file. */
export const NOTE_HEADER_SAMPLE: readonly string[] = [
  "```markdown",
  "---",
  "name: <short title>",
  "description: <one line saying what the note is about — recall decides on this line, so make it specific>",
  "type: <user | feedback | project | reference>",
  "---",
  "",
  "<the note itself; for feedback and project notes, the rule or fact first, then **Why:** and **How to apply:** lines>",
  "```",
]
