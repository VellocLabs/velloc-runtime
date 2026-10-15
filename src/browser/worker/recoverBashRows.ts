/**
 * Recovered `local_bash` drawer rows after a restart, derived from a loaded transcript: the
 * `{ shell_id, status }` handle (`shell_id` is the public task id; `running` → `stopped`) or the
 * running-shell launch ack + `<task-notification>`. Outcome and output load lazily from the sidecar
 * (`detailId`). Ids the registry still knows are skipped.
 */

import {
  isAssistantMessage,
  isTextPart,
  isToolResultPart,
  isToolUsePart,
  isUserMessage,
} from '../../runtime/VercelModelConstants'

export type RecoveredBashRow = {
  /** The public `b…` task id — the same id live/finished shell rows use. On the
   *  real inline shape it is `result.shell_id`; on the legacy handoff shape it
   *  is `result.task_id`. Row identity + the drawer's detail lookup key. */
  taskId: string
  /** The command the model ran (from the Bash/PowerShell tool-use args, or
   *  parsed from a completion summary). Drawer display label (rendered mono).
   *  Absent when neither source kept it — the publisher falls back to a label. */
  command?: string
  /** The tool-call id of the shell result — the tool-detail SIDECAR key. The
   *  drawer detail loads it lazily to render the persisted output + true
   *  pass/fail. Absent only for a completion recovered from a `<task-notification>`
   *  with no surviving tool-result (the `output_file` path carries it instead). */
  detailId?: string
  /** The host output-file path when the transcript kept it inline (the legacy
   *  handoff shape / a `<task-notification>` `<output-file>`). The real inline
   *  shape does NOT carry it — that shell's output comes from the sidecar via
   *  `detailId`. The drawer detail reads whichever is present, lazily. */
  outputFilePath?: string
  /** Terminal status from the transcript: a `completed`/legacy-completion shell
   *  → `success` (a `failed` notification → `error`); a shell still `running` at
   *  app close → `stopped`. Never `running` — a loaded transcript holds no live
   *  process. The precise `isError` for a `completed` shell is in its sidecar. */
  status: 'success' | 'error' | 'stopped'
  startedAt?: number
  finishedAt?: number
}

/** Mirrors MAX_FINISHED_* caps — the same "recent tail" the live registry keeps. */
export const MAX_RECOVERED_BASH_ROWS = 40

/** Tool names whose launches become `local_bash` tasks. */
export const SHELL_LAUNCH_TOOL_IDS = new Set(['Bash', 'PowerShell'])

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

/** Tool call id off a content part — both spellings (tool-use `id`/`toolCallId`,
 *  tool-result `toolCallId`/`toolUseId`). */
function partToolCallId(part: Record<string, unknown>): string | null {
  if (typeof part.id === 'string') return part.id
  if (typeof part.toolCallId === 'string') return part.toolCallId
  return typeof part.toolUseId === 'string' ? part.toolUseId : null
}

/** A tool-use part's tool name — `name` (legacy) or `toolName` (Vercel).
 *  Shared with `utils/branchSwitchDetect.ts`. */
export function partToolName(part: Record<string, unknown>): string | null {
  if (typeof part.name === 'string') return part.name
  return typeof part.toolName === 'string' ? part.toolName : null
}

/** A tool-use part's arguments — persisted (`input`) or Vercel (`args`) shape.
 *  Shared with `utils/branchSwitchDetect.ts`. */
export function partArgs(part: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(part.args) ?? asRecord(part.input)
}

function messageTimestamp(record: Record<string, unknown>): number | undefined {
  if (typeof record.timestamp !== 'string') return undefined
  const parsed = Date.parse(record.timestamp)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The text carried by a message content part (text part, or a stringy
 *  tool-result). */
function partText(part: Record<string, unknown>): string {
  if (typeof part.text === 'string') return part.text
  const result = part.result
  if (typeof result === 'string') return result
  return ''
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

const NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Scan a session transcript (persisted-message shapes, sanitized or not) for
 * shell launches + completions and project them to drawer rows, newest last.
 * Capped to the most recent MAX_RECOVERED_BASH_ROWS.
 */
export function extractRecoveredBashRows(
  messages: readonly unknown[],
): RecoveredBashRow[] {
  const byTaskId = new Map<string, RecoveredBashRow>()
  // Command + launch time captured from a shell tool-use, keyed by its call id
  // — consumed when the paired tool-result reveals the launch's task id. The
  // launch (assistant) message's timestamp is the shell's START; the inline
  // `{ shell_id, status: completed }` result carries only ONE timestamp (the
  // finish), so without this the recovered row would have no `startedAt` and
  // the drawer could render neither "started …" nor "took …" — only "done".
  const launchByCallId = new Map<string, { command?: string; startedAt?: number }>()

  const upsert = (
    taskId: string,
    patch: Partial<RecoveredBashRow> & { status: RecoveredBashRow['status'] },
  ): void => {
    const existing = byTaskId.get(taskId)
    if (!existing) {
      byTaskId.set(taskId, { taskId, ...patch })
      return
    }
    // A later anchor for the same shell refines the row: an authoritative
    // terminal status (a `<task-notification>` completion, or a completed
    // inline result) always wins — last terminal wins, as the pre-upsert code
    // did — while a bare `running` result (`stopped`) never downgrades a status
    // we already have. Any field the earlier anchor lacked is filled in.
    if (patch.status !== 'stopped') {
      existing.status = patch.status
    }
    if (existing.command === undefined && patch.command !== undefined) {
      existing.command = patch.command
    }
    if (existing.detailId === undefined && patch.detailId !== undefined) {
      existing.detailId = patch.detailId
    }
    if (existing.outputFilePath === undefined && patch.outputFilePath !== undefined) {
      existing.outputFilePath = patch.outputFilePath
    }
    if (existing.startedAt === undefined && patch.startedAt !== undefined) {
      existing.startedAt = patch.startedAt
    }
    if (patch.finishedAt !== undefined) existing.finishedAt = patch.finishedAt
  }

  // Every local_bash block of a `<task-notification>` batch is a completion.
  const scanNotifications = (text: string, at: number | undefined): void => {
    if (!text.includes('<task-notification>')) return
    NOTIFICATION_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = NOTIFICATION_RE.exec(text)) !== null) {
      const block = match[1]
      if (!/<task-type>local_bash<\/task-type>/.test(block)) continue
      const rawId = block.match(/<task-id>([\s\S]*?)<\/task-id>/)?.[1]
      if (!rawId) continue
      const id = unescapeXml(rawId).trim()
      if (!id) continue
      const statusRaw = block.match(/<status>([\s\S]*?)<\/status>/)?.[1]
      const status: RecoveredBashRow['status'] =
        statusRaw === 'failed' ? 'error' : 'success'
      const outputFile = block.match(
        /<output-file>([\s\S]*?)<\/output-file>/,
      )?.[1]
      const summaryCommand = block
        .match(/Background command "([\s\S]*?)" (?:completed|failed)/)?.[1]
      upsert(id, {
        ...(summaryCommand ? { command: unescapeXml(summaryCommand) } : {}),
        ...(outputFile ? { outputFilePath: unescapeXml(outputFile) } : {}),
        status,
        ...(at !== undefined ? { finishedAt: at } : {}),
      })
    }
  }

  for (const message of messages) {
    const record = asRecord(message)
    if (!record || typeof record.type !== 'string') continue
    // COMPLETION delivered MID-TURN — a `queued_command` attachment carrying
    // the same `<task-notification>` batch the idle turn would have.
    if (record.type === 'attachment') {
      const attachment = asRecord(record.attachment)
      if (
        attachment?.type === 'queued_command' &&
        attachment.commandMode !== 'prompt' &&
        typeof attachment.prompt === 'string'
      ) {
        scanNotifications(attachment.prompt, messageTimestamp(record))
      }
      continue
    }
    const inner = asRecord(record.message)
    const content = inner?.content
    const at = messageTimestamp(record)
    // COMPLETION delivered at the idle boundary — that turn's prompt is a plain
    // string, persisted as the user message's whole content, not a text part.
    if (typeof content === 'string') {
      if (isUserMessage(record as { type: string })) scanNotifications(content, at)
      continue
    }
    if (!Array.isArray(content)) continue

    if (isAssistantMessage(record as { type: string })) {
      for (const part of content) {
        const p = asRecord(part)
        if (!p || typeof p.type !== 'string') continue
        if (!isToolUsePart(p as { type: string })) continue
        if (!SHELL_LAUNCH_TOOL_IDS.has(partToolName(p) ?? '')) continue
        const callId = partToolCallId(p)
        if (!callId) continue
        const rawCommand = partArgs(p)?.command
        const command =
          typeof rawCommand === 'string' && rawCommand.trim()
            ? rawCommand.trim()
            : undefined
        // Keep the first-seen launch time; fill in whichever field a prior
        // part for this call id lacked.
        const prev = launchByCallId.get(callId)
        launchByCallId.set(callId, {
          command: command ?? prev?.command,
          startedAt: prev?.startedAt ?? at,
        })
      }
      continue
    }

    if (!isUserMessage(record as { type: string })) continue

    for (const part of content) {
      const p = asRecord(part)
      if (!p || typeof p.type !== 'string') continue

      if (isToolResultPart(p as { type: string })) {
        const result = asRecord(p.result)
        if (!result) continue
        const callId = partToolCallId(p) ?? undefined
        const launch = callId ? launchByCallId.get(callId) : undefined
        const command = launch?.command
        const status = result.status
        const running = status === 'running'

        // Real inline shape: the C++ ProcessTool handle `{ shell_id, status }`.
        // `shell_id` IS the public task id. Output + true isError are in the
        // sidecar, reached lazily on detail-open via `detailId`.
        const shellId = stringField(result.shell_id)
        if (shellId) {
          // `startedAt` comes from the launching tool-use turn (the shell's
          // start); a completed result additionally carries `finishedAt` (this
          // turn). This mirrors the live/finished registry rows so a recovered
          // shell renders "started … · took …" like every other task kind,
          // instead of a bare "done". A shell still running at close has no
          // finish time — its start falls back to this result turn if the
          // launch turn was trimmed.
          const startedAt = launch?.startedAt ?? (running ? at : undefined)
          upsert(shellId, {
            ...(command ? { command } : {}),
            ...(callId ? { detailId: callId } : {}),
            status: running ? 'stopped' : 'success',
            ...(startedAt !== undefined ? { startedAt } : {}),
            ...(running ? {} : at !== undefined ? { finishedAt: at } : {}),
          })
          continue
        }

        // Legacy running-shell handoff: `{ task_id, status:'running',
        // output_file }` (a genuinely backgrounded shell). Its terminal status
        // arrives later as a `<task-notification>`.
        const taskId = stringField(result.task_id)
        const outputFile = stringField(result.output_file)
        if (running && taskId && outputFile) {
          upsert(taskId, {
            ...(command ? { command } : {}),
            ...(callId ? { detailId: callId } : {}),
            outputFilePath: outputFile,
            status: 'stopped',
            ...(at !== undefined ? { startedAt: at } : {}),
          })
        }
        continue
      }

      // COMPLETION in a text part. One turn can batch several notifications.
      if (!isTextPart(p as { type: string })) continue
      scanNotifications(partText(p), at)
    }
  }

  const rows = Array.from(byTaskId.values())
  return rows.length > MAX_RECOVERED_BASH_ROWS
    ? rows.slice(rows.length - MAX_RECOVERED_BASH_ROWS)
    : rows
}
