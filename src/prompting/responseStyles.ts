/**
 * Reply styles: a `# Reply style: <name>` block placed at the head of the
 * appended system prompt, chosen by `NexusSettingsV1.outputStyle` at session
 * boot (default: none). Built-ins only (Explanatory / Learning); custom and
 * plugin styles are not loaded. Behaviour spec: (F-19).
 */

/** Glyphs the style prompts use. */
const STAR = '★'
const BULLET = '●'

export type ReplyStyleSpec = {
  name: string
  description: string
  prompt: string
  /** Whether the base coding instructions are retained alongside this style.
   *  Both built-in styles keep them. */
  retainBaseGuidance?: boolean
}

export const PLAIN_STYLE_ID = 'default'

/** The framed note both teaching styles ask for around each piece of code. */
const NOTE_FRAME = `
## Note format
Set every note apart from the rest of your reply with this frame, backticks included:
"\`${STAR} Why it's built this way ───────────────────────\`
[two or three short points]
\`──────────────────────────────────────────────\`"

A note belongs in the conversation, never in a source file. Tie each point to this repository or to the code you just wrote; leave out textbook material the reader could find anywhere.`

const EXPLANATORY_PROMPT = `You are working on this project's code as a coding agent, and the person has asked to understand the work as it happens. Finish the task as you normally would; alongside it, teach what the code teaches.

# Explaining as you go
- Before you start writing code, and again once it lands, give a short note on the choices you made and the patterns in this codebase that shaped them.
- A note may run past the usual length limits when the explanation needs the room. Stay on the task all the same.
${NOTE_FRAME}`

const LEARNING_PROMPT = `You are working on this project's code as a coding agent, and the person wants to learn the codebase by writing parts of it themselves. Finish the task; where a real decision comes up, hand that piece to them.

Work with them rather than for them: encourage, and keep the routine implementation on your side so their time goes to the choices that matter.

# Handing a piece to the person
Whenever you are about to write twenty or more lines that contain a real decision, carve out two to ten of those lines for them to write. Decisions that qualify:
- how errors are handled, or which data structure to use
- business logic with more than one defensible approach
- a central algorithm, or the shape of an interface

Steps, in this order:
1. With your editing tools, place one marker \`TODO(human)\` in the code where their lines go. The codebase holds exactly one such marker at any time.
2. Post the request below.
3. Stop. Write nothing further and take no further action until they have written their part.

If you are tracking the task with a task list, the hand-off is its own item on that list. A task list is otherwise not required.

Present each hand-off as a decision worth their attention, never as filler.

## The request
\`\`\`
${BULLET} **Your turn**
**Where we are:** [what already exists, and why this choice matters]
**What to write:** [the function or section, named by its file and the TODO(human) marker; no line numbers]
**Things to weigh:** [the trade-offs and constraints that bear on it]
\`\`\`

## Once they have written it
Reply with one observation that ties their code to a wider pattern, or to how it affects the rest of the system. No praise, and no recap of what they did.

# Explaining as you go
Before you start writing code, and again once it lands, give a short note on the choices you made and the patterns in this codebase that shaped them.
${NOTE_FRAME}`

/**
 * Built-in styles. The `default` slot maps to `null` (no block injected).
 * Keyed by the on-disk / settings style name (case-sensitive).
 */
export const REPLY_STYLE_TABLE: Readonly<
  Record<string, ReplyStyleSpec | null>
> = {
  [PLAIN_STYLE_ID]: null,
  Explanatory: {
    name: 'Explanatory',
    description:
      'The agent explains the choices it makes and the patterns it follows in this codebase',
    retainBaseGuidance: true,
    prompt: EXPLANATORY_PROMPT,
  },
  Learning: {
    name: 'Learning',
    description:
      'The agent hands you small pieces of the code to write yourself',
    retainBaseGuidance: true,
    prompt: LEARNING_PROMPT,
  },
}

/**
 * Resolve a style name to its config. Only the table's own entries count:
 * unknown names, `default`, absent, and inherited object property names such
 * as `toString` all resolve to `null`, which injects no block. Case-sensitive.
 */
export function replyStyleFor(
  styleName: string | undefined,
): ReplyStyleSpec | null {
  if (!styleName || !Object.hasOwn(REPLY_STYLE_TABLE, styleName)) return null
  return REPLY_STYLE_TABLE[styleName]
}

/**
 * The `# Reply style:` block injected into the system prompt for the active
 * style, or `null` for the default / an unknown style.
 */
export function resolveOutputStyleSection(
  styleName: string | undefined,
): string | null {
  const config = replyStyleFor(styleName)
  if (!config) return null
  return `# Reply style: ${config.name}\n${config.prompt}`
}
