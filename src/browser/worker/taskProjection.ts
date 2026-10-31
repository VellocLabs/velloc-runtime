/**
 * Pure projections for background tasks: transcript text/entries, finished-record snapshots, drawer
 * labels and `<task-notification>` formatting.
 */
import type { NexusTaskTranscriptEntry } from '../bridge/protocol/ui'
import type { SubAgentSnapshot } from '../../team/subAgentController'
import type { ForkTaskStart } from '../../backgroundTasks/sideTaskSink'
import type { FinishedSubAgentRecord, NexusTaskDeliveryResult } from './taskTypes'

/**
 * The last assistant-message text in a StreamRecord list (block-array or top-level `text` shapes), or ''.
 */
export function extractFinalAssistantText(messages: readonly unknown[]): string {
  return extractFinalAssistantMessage(messages)?.text ?? ''
}

/**
 * The message `extractFinalAssistantText` reads, with its `uuid` when the
 * message carries one, or null when no assistant text exists. The teammate
 * turn-end report compares the uuid, not the text: two turns that end in the
 * same words are two reports, while a turn that produced no text re-reads the
 * SAME message and must not be reported again.
 */
export function extractFinalAssistantMessage(
  messages: readonly unknown[],
): { uuid?: string; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { type?: string; uuid?: unknown } | undefined
    if (!m || m.type !== 'assistant') continue
    const uuid = typeof m.uuid === 'string' ? m.uuid : undefined
    // Text blocks live at `message.content` on the canonical SDK assistant
    // shape (`{ type: 'assistant', message: { content: [...] } }` — what the
    // engine yields and `sanitizeSdkMessageForUi` preserves). A top-level
    // `content` / `text` is the fallback for provider/test shapes. Reading ONLY
    // the top-level form left the manager's sub-agent / headless summaries empty
    // (the run's actual answer is nested under `message`), so `TaskOutput` and
    // the auto-delivery reported "(no output)" for a sub-agent that did answer.
    const nested = (m as { message?: { content?: unknown } }).message?.content
    const blocks = Array.isArray(nested)
      ? nested
      : Array.isArray((m as { content?: unknown }).content)
        ? ((m as { content?: unknown }).content as unknown[])
        : null
    if (blocks) {
      const texts: string[] = []
      for (const b of blocks) {
        const block = b as { type?: string; text?: string }
        if (block?.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text)
        }
      }
      if (texts.length > 0) {
        return { ...(uuid ? { uuid } : {}), text: texts.join('\n') }
      }
    }
    const top = (m as { text?: unknown }).text
    if (typeof top === 'string' && top.length > 0) {
      return { ...(uuid ? { uuid } : {}), text: top }
    }
  }
  return null
}

/**
 * Project a sub-agent's persisted transcript (raw `BrowserTranscriptEntry[]` or
 * a `BrowserConversationRecord`'s `messages`) into the compact read-only entries
 * the Background Tasks drawer's detail view renders: each user/assistant step's
 * text plus the names of any tools the assistant invoked. Skips meta/title
 * entries and tool-result-only user turns. Tolerant of the SDK + provider
 * message shapes (mirrors `extractFinalAssistantText`'s block handling).
 */
export function projectSubAgentTranscript(
  messages: readonly unknown[],
): NexusTaskTranscriptEntry[] {
  const out: NexusTaskTranscriptEntry[] = []
  for (const raw of messages) {
    const m = raw as {
      type?: string
      message?: { content?: unknown }
      content?: unknown
      text?: unknown
    }
    if (m?.type !== 'user' && m?.type !== 'assistant') continue
    const nested = m.message?.content
    const blocks = Array.isArray(nested)
      ? nested
      : Array.isArray(m.content)
        ? (m.content as unknown[])
        : null
    const texts: string[] = []
    const tools: string[] = []
    if (blocks) {
      for (const b of blocks) {
        const block = b as {
          type?: string
          text?: string
          name?: string
          toolName?: string
        }
        if (block?.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text)
        } else if (block?.type === 'tool-call' || block?.type === 'tool_use') {
          // Live stream messages carry the canonical Vercel shape
          // ({ type: 'tool-call', toolName }); persisted/bridge data carries the
          // legacy Anthropic shape ({ type: 'tool_use', name }). Recognizing
          // only the legacy one dropped every tool-only turn from a RUNNING
          // sub-agent — those turns have no text block, so the `!text && !tools`
          // guard below discarded them, collapsing a 141-turn Explore run to
          // just its intro + final text in the drawer. Accept both shapes.
          const toolName = block.toolName ?? block.name
          if (typeof toolName === 'string') {
            tools.push(toolName)
          }
        }
      }
    } else if (typeof m.content === 'string') {
      texts.push(m.content)
    } else if (typeof m.text === 'string') {
      texts.push(m.text)
    }
    const text = texts.join('\n').trim()
    if (!text && tools.length === 0) continue
    out.push({ role: m.type, text, tools })
  }
  return out
}

export function finishedRecordToSnapshot(rec: FinishedSubAgentRecord): SubAgentSnapshot {
  return {
    // Public `a…` taskId (fallback to native for directly-seeded test records).
    sessionId: rec.taskId ?? rec.sessionId,
    status: rec.status,
    description: rec.description,
    agentType: rec.agentType,
    output: rec.summary,
    startedAt: rec.startedAt,
  }
}

/** Drawer display label for a fork task: the caller's own description when
 *  set, else a human name derived from the spawning side-channel. */
export function forkDisplayLabel(start: ForkTaskStart): string {
  if (start.description) return start.description
  switch (start.querySource) {
    case 'skill_fork':
      return `Skill: ${start.forkLabel}`
    case 'extract_memories':
      return 'Memory extraction'
    case 'periodic_tidy':
      return 'Periodic memory tidy'
    case 'hook_agent':
      return 'Hook agent'
    case 'agent_tool':
      return 'Fork'
    default:
      return start.forkLabel || 'Fork'
  }
}

/** English label for a fast-model one-shot, by its telemetry tag — the row's
 *  `description` for non-UI consumers. The worker has no locale: the drawer
 *  shows a catalog label resolved from the row's `querySource` instead
 *  (`taskRowLabelKey`, webview/backgroundSubAgents.ts); keep the two maps in
 *  step. */
export function fastCallDisplayLabel(querySource: string): string {
  switch (querySource) {
    case 'rename_generate_name':
      return 'Session title'
    case 'memory_recall':
      return 'Automatic recall'
    case 'web_fetch_apply':
      return 'WebFetch extraction'
    default:
      return 'Fast model call'
  }
}

/** Drawer display label for a `SuperEdit` task when the model gave no
 *  `description`. A worker-side default (like the fork/fast labels above); the
 *  drawer renders row descriptions raw, so this is an English literal ("Super
 *  Edit", a coined name kept as-is in every locale). */
export function runJsDisplayLabel(): string {
  return 'Super Edit'
}

/**
 * Mid-turn drain priority (drain now vs. drain later): shell work — a background
 * shell, or a SuperShell script, whose whole reason to exist is running
 * commands — is drained into the running turn after every tool round; anything
 * else (sub-agents) only after a round that ran Sleep.
 */
export function isNextPriorityTaskResult(result: NexusTaskDeliveryResult): boolean {
  return result.type === 'local_bash' || result.type === 'local_supershell'
}

/** Escape the XML metacharacters for text embedded in a `<task-notification>`. */
export function escapeTaskXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Render finished results into ONE delivery turn of `<task-notification>` blocks, each with the public
 * `<task-id>`, `<task-type>`, status (completed|failed|killed) and, for shells, `<output-file>`.
 */
export function formatTaskNotifications(
  results: readonly NexusTaskDeliveryResult[],
): string {
  return results
    .map((r) => {
      const status = r.status === 'error' ? 'failed' : 'completed'
      const outputFileLine =
        r.type === 'local_bash' && r.outputFilePath
          ? `\n<output-file>${escapeTaskXml(r.outputFilePath)}</output-file>`
          : ''
      const summary =
        r.type === 'local_bash'
          ? // The shell summary restates the command + status, then the
            // captured output.
            `Background command "${r.command}" ${status}${
              r.summary ? `\n${r.summary}` : ''
            }`
          : r.type === 'local_supershell'
            ? `SuperShell script "${r.description}" ${status}${r.summary ? `\n${r.summary}` : ''}`
            : r.type === 'local_plugin'
              ? `${r.description} (${r.plugin}): ${r.summary}`
              : r.agentType
                ? `${r.description} (${r.agentType}): ${r.summary}`
                : `${r.description}: ${r.summary}`
      return (
        `<task-notification>\n` +
        `<task-id>${escapeTaskXml(r.taskId)}</task-id>\n` +
        `<task-type>${r.type}</task-type>` +
        `${outputFileLine}\n` +
        `<status>${status}</status>\n` +
        `<summary>${escapeTaskXml(summary)}</summary>\n` +
        `</task-notification>`
      )
    })
    .join('\n')
}

/**
 * The nested-session id predicates. A sub-agent (`subagent-…`) is never a user-facing session; a
 * teammate (`teammate-…`) is, and is hidden from the sidebar by `spawnerSessionId`, not this prefix.
 */
export {
  isSubAgentSessionId,
  isTeammateSessionId,
} from '../../utils/sidechainStoragePaths'
