/**
 * Attachment renderers: `ContextRow` → the meta user message(s) the model sees.
 * Peers of the collectors in `attachments.ts`; neither imports the other.
 */

import type {
  ContextRow,
  BrowserContextAttachment,
  ContentBlockParam,
  DirectoryAttachment,
  FilePartsAttachment,
  FolderTreeAttachment,
  GitStateAttachment,
  InvokedSkillsAttachment,
  Message,
  PDFDocumentAttachment,
  PdfPointer,
  PlanModeAttachment,
  PlanModeExitAttachment,
  PlanModeReentryAttachment,
  SkillDiscoveryAttachment,
  SkillListingAttachment,
  TextFileAttachment,
  TodoReminderAttachment,
  UserRow,
} from '../runtime/RuntimeTypes'
import { READ_TOOL_ID } from '../prompting/fileToolNames'
import { SHELL_TOOL_ID } from '../prompting/processToolNames'
import { SKILL_TOOL_NAME } from '../prompting/skillToolName'
import { createGeneratedUserMessage } from './messageFactories'
import { PART_DOCUMENT, PART_IMAGE, PART_TEXT } from '../runtime/VercelModelConstants'

// The slice an over-budget @-mentioned file is cut to, in lines.
const AT_MENTION_TRUNCATED_LINES = 2_000

/** Cap on the inlined DOM / accessibility snapshot text, in characters. */
const DOM_SNAPSHOT_LIMIT = 2_000

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value
  }
  return `${value.slice(0, limit)}…`
}

function renderBrowserContextAttachment(attachment: BrowserContextAttachment): UserRow {
  // Today's date is NOT inlined here. It lives once in the cached
  // userContext (`buildBrowserUserContext.currentDate`), and rollover
  // past midnight is announced via the lazy `date_change` attachment
  // (see `collectDateChangeAttachments` below): the date sits in the cached
  // prefix and only a change is announced at the tail. Keeping the date out of this per-turn payload
  // means a session that emits the same browser snapshot across
  // consecutive turns no longer pays the "Today: ..." token cost on
  // each one.
  const activeTab = attachment.activeTab
    ? [
        `Active tab: ${String(attachment.activeTab.title ?? '(untitled)')}`,
        `URL: ${String(attachment.activeTab.url ?? '(no url)')}`,
      ].join('\n')
    : 'Active tab: none'

  const tabs = attachment.tabs.length === 0
    ? 'Tabs: none'
    : [
        'Tabs:',
        ...attachment.tabs.map(tab => {
          const title = String(tab.title ?? '(untitled)')
          const url = String(tab.url ?? '(no url)')
          const state = tab.active ? 'active' : 'background'
          return `- [${state}] ${title} <${url}>`
        }),
      ].join('\n')

  const domSnapshot =
    typeof attachment.domSnapshot?.content === 'string'
      ? `DOM snapshot:\n${truncate(String(attachment.domSnapshot.content), DOM_SNAPSHOT_LIMIT)}`
      : null
  const accessibilitySnapshot = attachment.accessibilitySnapshot?.nodes
    ? `Accessibility snapshot:\n${truncate(JSON.stringify(attachment.accessibilitySnapshot.nodes), DOM_SNAPSHOT_LIMIT)}`
    : null

  const text = [
    'Browser context attachment:',
    activeTab,
    tabs,
    attachment.workspace
      ? `Workspace: ${JSON.stringify(attachment.workspace)}`
      : null,
    attachment.userProfile
      ? `User profile: ${JSON.stringify(attachment.userProfile)}`
      : null,
    domSnapshot,
    accessibilitySnapshot,
  ]
    .filter(Boolean)
    .join('\n\n')

  return createGeneratedUserMessage(text)
}

// Wraps harness text in the `<system-reminder>` envelope.
function encloseHarnessNote(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`
}

// A synthetic "called the tool" line, shown to the model as a tool call.
function syntheticToolUseMessage(
  toolName: string,
  input: Record<string, string | number>,
): UserRow {
  return createGeneratedUserMessage(
    encloseHarnessNote(
      `Called the ${toolName} tool with the following input: ${JSON.stringify(input)}`,
    ),
  )
}

// A synthetic tool result with string content.
function syntheticToolResultMessage(toolName: string, content: string): UserRow {
  return createGeneratedUserMessage(
    encloseHarnessNote(`Result of calling the ${toolName} tool:\n${content}`),
  )
}

// A text `file` mention is shown to the
// model as the Read call that produced it — the content is Read's own `cat -n`
// output — plus the truncation note when only the first lines were read.
// A `file` attachment persisted before Read did the reading holds the raw
// text; it renders the same way, without line numbers.
function renderTextFileAttachment(attachment: TextFileAttachment): UserRow[] {
  return [
    syntheticToolUseMessage(READ_TOOL_ID, { file_path: attachment.filename }),
    syntheticToolResultMessage(READ_TOOL_ID, attachment.content.file.content),
    ...(attachment.truncated
      ? [
          createGeneratedUserMessage(
            encloseHarnessNote(
              `Note: The file ${attachment.filename} was too large and has been truncated to the first ${AT_MENTION_TRUNCATED_LINES} lines. Don't tell the user about this truncation. Use ${READ_TOOL_ID} to read more of the file if you need.`,
            ),
          ),
        ]
      : []),
  ]
}

// An image / notebook mention: the Read call, then its result. With an image
// the result keeps its blocks as they are, text blocks wrapped;
// text-only parts (a notebook without images) are one text result.
function renderFilePartsAttachment(attachment: FilePartsAttachment): UserRow[] {
  const call = syntheticToolUseMessage(READ_TOOL_ID, {
    file_path: attachment.filename,
    ...(attachment.pages ? { pages: attachment.pages } : {}),
  })
  if (!attachment.parts.some(part => part.type === 'image')) {
    const text = attachment.parts
      .map(part => (part.type === 'text' ? part.text : ''))
      .join('\n')
    return [call, syntheticToolResultMessage(READ_TOOL_ID, text)]
  }
  const content = attachment.parts.map(part =>
    part.type === 'text'
      ? { type: PART_TEXT, text: encloseHarnessNote(part.text) }
      : { type: PART_IMAGE, image: part.image, mimeType: part.mimeType },
  ) as ContentBlockParam[]
  return [call, createGeneratedUserMessage(content)]
}

// POSIX single-quoting where needed.
function shellQuotePath(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

// A directory mention is shown as the `ls` that lists it.
function renderDirectoryAttachment(attachment: DirectoryAttachment): UserRow[] {
  return [
    syntheticToolUseMessage(SHELL_TOOL_ID, {
      command: `ls ${shellQuotePath(attachment.path)}`,
      description: `Lists files in ${attachment.path}`,
    }),
    syntheticToolResultMessage(SHELL_TOOL_ID, attachment.content),
  ]
}

// A PDF too large to inline: tell the model to read it in page ranges. The
// size is given in bytes.
function renderPdfReferenceAttachment(
  attachment: PdfPointer,
): UserRow {
  if (attachment.unreadable === 'text-only-model') {
    // A text-only model: a paged Read returns page images, so the note below
    // would send the model into Reads whose results it cannot see.
    return createGeneratedUserMessage(
      `<system-reminder>\n` +
        `PDF file: ${attachment.filename} (${attachment.pageCount} pages, ${attachment.fileSize} bytes). ` +
        `The current model cannot take images or documents, so this PDF's pages cannot be read in this session ` +
        `(the ${READ_TOOL_ID} tool returns PDF pages as images). Do NOT try to read it with ${READ_TOOL_ID}. ` +
        `Tell the user, and suggest switching to a model with image input to read it.\n` +
        `</system-reminder>`,
    )
  }
  const text =
    `<system-reminder>\n` +
    `PDF file: ${attachment.filename} (${attachment.pageCount} pages, ${attachment.fileSize} bytes). ` +
    `This PDF is too large to read all at once. You MUST use the ${READ_TOOL_ID} tool with the pages parameter ` +
    `to read specific page ranges (e.g., pages: "1-5"). Do NOT call ${READ_TOOL_ID} without the pages parameter ` +
    `or it will fail. Start by reading the first few pages to understand the structure, then read more as needed. ` +
    `Maximum 20 pages per request.\n` +
    `</system-reminder>`

  return createGeneratedUserMessage(text)
}

// An inlined @-file renders as a synthetic Read call plus its result, with
// the document part the result carries — so the model gets the PDF in the turn it was mentioned.
function renderPdfDocumentAttachment(
  attachment: PDFDocumentAttachment,
): UserRow {
  const content: ContentBlockParam[] = [
    {
      type: PART_TEXT,
      text:
        `Called the ${READ_TOOL_ID} tool with the following input: ` +
        JSON.stringify({ file_path: attachment.filename }) +
        `\nResult: ${attachment.summary}`,
    },
    {
      type: PART_DOCUMENT,
      data: attachment.data,
      mimeType: attachment.mimeType,
    },
  ] as ContentBlockParam[]
  return createGeneratedUserMessage(content)
}

function renderSkillListingAttachment(
  attachment: SkillListingAttachment,
): UserRow {
  const text = [
    attachment.isInitial
      ? `The following local skills are available via the ${SKILL_TOOL_NAME} tool:`
      : `Additional local skills are now available via the ${SKILL_TOOL_NAME} tool:`,
    attachment.content,
  ].join('\n\n')

  return createGeneratedUserMessage(text)
}

function renderSkillDiscoveryAttachment(
  attachment: SkillDiscoveryAttachment,
): UserRow {
  const lines = attachment.skills.map(
    skill => `- ${skill.name}: ${skill.description}`,
  )
  return createGeneratedUserMessage(
    [
      `Skills relevant to the current task are available via the ${SKILL_TOOL_NAME} tool:`,
      ...lines,
    ].join('\n'),
  )
}

// The plan-file status line shared by the full + re-entry reminders.
function planFileInfoLine(planFilePath: string, planExists: boolean): string {
  return planExists
    ? `A plan file already exists at ${planFilePath}. Read it before changing direction, then keep it up to date as you plan.`
    : `No plan file exists yet — create and grow your plan at ${planFilePath}.`
}

/**
 * Plan-mode reminder as a `<system-reminder>` meta user message: `full` on the
 * first plan-mode turn (and periodically), `sparse` between. `hasSubagents`
 * picks the `Explore` / `Plan` sub-agent workflow over a direct read-only one.
 */
function renderPlanModeAttachment(attachment: PlanModeAttachment): UserRow {
  if (attachment.reminderType === 'sparse') {
    const text = [
      'Plan mode still active (full instructions earlier in this conversation).',
      `Read-only except the plan file (${attachment.planFilePath}).`,
      'End your turn with AskUserQuestion (to clarify) or ExitPlanMode (to present the plan for approval). Never ask about plan approval via plain text or AskUserQuestion.',
    ].join(' ')
    return createGeneratedUserMessage(
      `<system-reminder>\n${text}\n</system-reminder>`,
    )
  }

  const exploreStep = attachment.hasSubagents
    ? 'Explore — understand the request and the relevant code. Search for existing functions, utilities, and patterns to reuse before proposing anything new. For broad or multi-area exploration, launch several `Agent` calls with subagent_type=Explore IN PARALLEL (a single message with multiple tool calls); use the minimum number of agents needed.'
    : 'Explore — understand the request and the relevant code using Read, Grep, and Glob. Search for existing functions, utilities, and patterns to reuse before proposing anything new.'
  const designStep = attachment.hasSubagents
    ? 'Design — once you understand the code, launch `Agent` with subagent_type=Plan to design the implementation, passing the context you gathered. Fold the result into the plan file: what to change, which files to modify, the existing code to reuse (with paths), and how to verify the change end-to-end.'
    : 'Design — capture the approach in the plan file as you learn: what to change, which files to modify, the existing code to reuse (with paths), and how to verify the change end-to-end.'

  const body = [
    'Plan mode is active. The user does not want you to execute yet — you MUST NOT make any edits (other than the plan file below), run any non-read-only tools (including changing configs or making commits), or otherwise change the system. This supersedes any other instructions you have received.',
    // The plan gate allows browser BROWSING, so tell the model it may research
    // that way instead of assuming the browser is off-limits.
    'Browsing the attached browser for research IS allowed (navigate, search, scroll, switch tabs, read pages) — but do NOT interact with pages: no clicking, typing, form input, JS, uploads, or downloads.',
    '',
    '## Plan file',
    planFileInfoLine(attachment.planFilePath, attachment.planExists),
    'This is the ONLY file you may edit — otherwise take READ-ONLY actions only.',
    '',
    '## Workflow',
    `1. ${exploreStep}`,
    `2. ${designStep}`,
    "3. Clarify — when you hit a decision you can't resolve from the code alone, use AskUserQuestion. Never ask what you could find out by reading the code.",
    '',
    '## Ending your turn',
    'End EVERY plan-mode turn with exactly one of:',
    '- AskUserQuestion — to gather missing requirements or choose between approaches, or',
    '- ExitPlanMode — to present the finished plan for approval.',
    'Do NOT request plan approval any other way. Phrases like "Is this plan okay?", "Should I proceed?", or "How does this look?" MUST use ExitPlanMode — not plain text, not AskUserQuestion.',
  ].join('\n')

  return createGeneratedUserMessage(`<system-reminder>\n${body}\n</system-reminder>`)
}

// Sent when a session enters plan mode again with a plan file on disk.
function renderPlanModeReentryAttachment(
  attachment: PlanModeReentryAttachment,
): UserRow {
  const body = [
    '## Re-entering plan mode',
    `You are returning to plan mode. A plan file exists at ${attachment.planFilePath} from a previous planning session. Before planning further:`,
    '1. Read the existing plan file to understand what was planned.',
    "2. Evaluate the user's current request against it.",
    '3. If this is a different task, start fresh by overwriting the plan; if it is a continuation of the same task, refine it and remove outdated sections.',
    'Always edit the plan file one way or the other before calling ExitPlanMode. Treat this as a fresh planning session — do not assume the existing plan is still relevant.',
  ].join('\n')
  return createGeneratedUserMessage(`<system-reminder>\n${body}\n</system-reminder>`)
}

// Sent on the turn after plan mode is left.
function renderPlanModeExitAttachment(
  attachment: PlanModeExitAttachment,
): UserRow {
  const planReference = attachment.planExists
    ? ` The plan file is at ${attachment.planFilePath} if you need to reference it.`
    : ''
  const body =
    '## Exited plan mode\n' +
    `You have exited plan mode. You can now make edits, run tools, and take actions.${planReference}`
  return createGeneratedUserMessage(`<system-reminder>\n${body}\n</system-reminder>`)
}

/**
 * Render the `todo_reminder` attachment as a meta user message wrapped in a
 * `<system-reminder>`, including the "NEVER mention this reminder"
 * instruction and the `[1. [status] content]` list format. An empty list still renders the nudge, just without the
 * contents section.
 */
function renderTodoReminderAttachment(
  attachment: TodoReminderAttachment,
): UserRow {
  const todoItems = attachment.content
    .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
    .join('\n')

  let message = `The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user\n`
  if (todoItems.length > 0) {
    message += `\n\nHere are the existing contents of your todo list:\n\n[${todoItems}]`
  }

  return createGeneratedUserMessage(
    `<system-reminder>\n${message}\n</system-reminder>`,
  )
}

/**
 * The `invoked_skills` attachment as a `<system-reminder>` meta user message of
 * `### Skill: <name>\nPath: <path>\n\n<content>` blocks separated by `---`;
 * empty when it carries no skills.
 */
function renderInvokedSkillsAttachment(
  attachment: InvokedSkillsAttachment,
): UserRow[] {
  if (attachment.skills.length === 0) {
    return []
  }
  const blocks = attachment.skills
    .map(
      skill =>
        `### Skill: ${skill.name}\nPath: ${skill.path}\n\n${skill.content}`,
    )
    .join('\n\n---\n\n')
  return [
    createGeneratedUserMessage(
      `<system-reminder>\nThe following skills were invoked in this session. Continue to follow these guidelines:\n\n${blocks}\n</system-reminder>`,
    ),
  ]
}

/**
 * User input sent while the turn was running (plain Enter), injected between
 * tool rounds, wrapped in `<system-reminder>`. NOT isMeta — it is the user's
 * own words. A content-array prompt keeps its non-text blocks (images) after
 * one wrapped text block.
 */
function renderQueuedUserPrompt(
  prompt: string | Array<ContentBlockParam>,
): UserRow {
  const wrap = (text: string) =>
    `<system-reminder>\nThe user sent a new message while you were working:\n${text}\n\nIMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.\n</system-reminder>`
  if (typeof prompt === 'string') {
    return createGeneratedUserMessage(wrap(prompt), { isMeta: false })
  }
  const text = prompt
    .filter(block => (block as { type?: unknown }).type === 'text')
    .map(block => (block as { text?: string }).text ?? '')
    .join('\n')
  const others = prompt.filter(block => (block as { type?: unknown }).type !== 'text')
  return createGeneratedUserMessage(
    [{ type: 'text', text: wrap(text) } as ContentBlockParam, ...others],
    { isMeta: false },
  )
}

export function renderAttachmentMessage(
  message: ContextRow,
): Message[] {
  switch (message.attachment.type) {
    case 'queued_command':
      if (message.attachment.commandMode === 'prompt') {
        return [renderQueuedUserPrompt(message.attachment.prompt)]
      }
      if (message.attachment.commandMode === 'team-message') {
        // The frame text is already the model-facing form (an untrusted one
        // carries its own quarantine envelope). Not isMeta: like a frame
        // delivered as a turn, it is a message the model must answer.
        return [
          createGeneratedUserMessage(
            `<system-reminder>\nA team message arrived while you were working:\n${message.attachment.prompt}\n</system-reminder>`,
            { isMeta: false },
          ),
        ]
      }
      // A task notification: prefixed, wrapped in `<system-reminder>`, and
      // isMeta (createGeneratedUserMessage's default) since the system
      // generated it. Shells use the same "background agent" wording.
      return [
        createGeneratedUserMessage(
          `<system-reminder>\nA background agent completed a task:\n${message.attachment.prompt}\n</system-reminder>`,
        ),
      ]
    case 'browser_context':
      return [renderBrowserContextAttachment(message.attachment)]
    case 'file':
      return renderTextFileAttachment(message.attachment)
    case 'file_parts':
      return renderFilePartsAttachment(message.attachment)
    case 'directory':
      return renderDirectoryAttachment(message.attachment)
    case 'pdf_reference':
      return [renderPdfReferenceAttachment(message.attachment)]
    case 'pdf_document':
      return [renderPdfDocumentAttachment(message.attachment)]
    case 'skill_listing':
      return [renderSkillListingAttachment(message.attachment)]
    case 'skill_discovery':
      return [renderSkillDiscoveryAttachment(message.attachment)]
    case 'plan_mode':
      return [renderPlanModeAttachment(message.attachment)]
    case 'plan_mode_reentry':
      return [renderPlanModeReentryAttachment(message.attachment)]
    case 'plan_mode_exit':
      return [renderPlanModeExitAttachment(message.attachment)]
    case 'invoked_skills':
      return renderInvokedSkillsAttachment(message.attachment)
    case 'todo_reminder':
      return [renderTodoReminderAttachment(message.attachment)]
    case 'max_turns_reached':
      return [
        createGeneratedUserMessage(
          `Maximum turn limit reached (${message.attachment.turnCount}/${message.attachment.maxTurns}).`,
        ),
      ]
    case 'date_change':
      // <system-reminder> wrapper, like the per-turn nudge wrap at
      // engine/conversationEngine.ts. createGeneratedUserMessage defaults to isMeta:true.
      return [
        createGeneratedUserMessage(
          `<system-reminder>\nThe date has changed. Today's date is now ${message.attachment.newDate}. DO NOT mention this to the user explicitly because they are already aware.\n</system-reminder>`,
        ),
      ]
    case 'git_state':
      return [createGeneratedUserMessage(renderGitStateReminder(message.attachment))]
    case 'folder_tree':
      return [createGeneratedUserMessage(renderFolderTreeReminder(message.attachment))]
    default:
      return []
  }
}

/** The first-turn folder listing as the model reads it. */
export function renderFolderTreeReminder(tree: FolderTreeAttachment): string {
  const lines = [
    '<system-reminder>',
    'Files under the primary working directory when this session began, a few levels deep, names only; dependency and build folders are not expanded. This is a snapshot taken once; it does not update.',
    ...tree.lines,
  ]
  if (tree.truncated) lines.push('… more entries not listed')
  lines.push('</system-reminder>')
  return lines.join('\n')
}

/** The first-turn git snapshot as the model reads it: a reminder that says
 *  it is a snapshot, the branch line, then the change lines. */
export function renderGitStateReminder(state: GitStateAttachment): string {
  const tracking: string[] = []
  if (state.upstream) tracking.push(`tracking ${state.upstream}`)
  if (state.ahead) tracking.push(`ahead ${state.ahead}`)
  if (state.behind) tracking.push(`behind ${state.behind}`)
  const branch = state.branch
    ? `Branch: ${state.branch}${tracking.length > 0 ? ` (${tracking.join(', ')})` : ''}`
    : 'Branch: none (detached HEAD)'
  const count = state.changes.length + state.more
  const lines = [
    '<system-reminder>',
    'Git state of the primary working directory when this session began. This is a snapshot taken once; it does not update. Run git for the current state.',
    ...(state.root ? [`Repository root: ${state.root} (the working directory is a folder inside it; the changes below are its own, with paths relative to this root)`] : []),
    branch,
    count === 0 ? 'Working tree: clean' : `Working tree: ${count} changed path${count === 1 ? '' : 's'}`,
    ...state.changes,
  ]
  if (state.more > 0) lines.push(`… and ${state.more} more`)
  lines.push('</system-reminder>')
  return lines.join('\n')
}
