/**
 * Bundled `debug` skill (slash-only): puts the recent runtime log (the
 * in-memory `workerLogBuffer` ring) into the prompt to diagnose the runtime
 * itself, not the user's code. Invoking it enables trace capture; when it was
 * off, the prompt asks the user to reproduce.
 */

import { addStockSkill } from '../builtinSkills'
import { startTraceCapture } from '../../utils/debugLog'
import {
  getWorkerLogBuffer,
  type WorkerLogEntry,
} from '../../utils/workerLogBuffer'

/** How many of the most recent log entries the prompt shows. */
const DEFAULT_RECENT_ENTRIES = 20
/** Cap on bytes per entry's `text` field embedded in the prompt — keeps a
 *  single huge stack trace from blowing the prompt. */
const MAX_TEXT_CHARS_PER_ENTRY = 2_000

function formatTime(timeMs: number): string {
  // `2026-06-06T14:23:45.123Z` → `14:23:45.123` — concise, sortable.
  try {
    const iso = new Date(timeMs).toISOString()
    return iso.slice(11, 23)
  } catch {
    return String(timeMs)
  }
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function formatEntry(entry: WorkerLogEntry): string {
  const tag = entry.source ? ` [${entry.source}]` : ''
  return `[${formatTime(entry.timeMs)}] [${entry.level}]${tag} ${clamp(
    entry.text,
    MAX_TEXT_CHARS_PER_ENTRY,
  )}`
}

function formatBridgeTrace(): string | null {
  // The bridge tracer pushes records into a global array when `?e2eTrace=1`
  // is set. When the flag is off the array is `undefined` — skip the
  // section entirely so the prompt isn't padded with an empty block.
  const arr = (globalThis as { __NEXUS_BRIDGE_TRACE__?: unknown[] })
    .__NEXUS_BRIDGE_TRACE__
  if (!Array.isArray(arr) || arr.length === 0) return null
  const recent = arr.slice(-DEFAULT_RECENT_ENTRIES)
  try {
    return recent
      .map((evt, i) => `${i + 1}. ${clamp(JSON.stringify(evt), 600)}`)
      .join('\n')
  } catch {
    return `(${recent.length} bridge events — failed to serialise)`
  }
}

/**
 * Build the live debug prompt at invocation time: a header describing the
 * diagnostic mode, the last `DEFAULT_RECENT_ENTRIES` log entries, optional
 * bridge-trace context, the user's issue description, and instructions for
 * how the model should investigate.
 */
async function getDebugPrompt(args: string): Promise<string> {
  // Invoking /debug turns debug capture on so subsequent activity is recorded at
  // debug/info level too — warn/error were captured all along.
  const wasAlreadyLogging = startTraceCapture()

  const entries = getWorkerLogBuffer().drain()
  const recent = entries.slice(-DEFAULT_RECENT_ENTRIES)
  const tail =
    recent.length === 0
      ? '(no entries captured yet — reproduce the issue and re-run `/debug`)'
      : recent.map(formatEntry).join('\n')

  const bufferStatus =
    entries.length === 0
      ? 'Empty — no warnings or errors captured in this session yet.'
      : `${entries.length} entries captured (ring buffer caps at 500; oldest age out).`

  const justEnabledSection = wasAlreadyLogging
    ? ''
    : `
## Debug Capture Just Enabled

Sub-warn debug capture (\`[tool]\` start/done, \`[query]\` loop branches,
\`[mcp]\` connect lifecycle) was OFF until this /debug invocation — only
warnings and errors above were recorded before now.

Tell the user debug capture is now active, ask them to reproduce the issue,
then re-run \`/debug\` so the detailed trail lands in the log below. They can
turn it off later with \`/debug log off\`.
`

  const bridgeTrace = formatBridgeTrace()
  const bridgeSection = bridgeTrace
    ? `\n\n## Recent Bridge Trace Events (last ${DEFAULT_RECENT_ENTRIES})

\`\`\`
${bridgeTrace}
\`\`\`
`
    : '\n\n## Bridge Trace\n\nNot enabled this session. To capture bridge events, reload with `?e2eTrace=1` on the URL.\n'

  const userIssue = args.trim()
  const issueSection = userIssue
    ? `## Issue Reported\n\n${userIssue}\n`
    : `## Issue Reported\n\n(none specified — diagnose any anomalies you see in the log)\n`

  return `# Debug Nexus Skill

You are diagnosing an issue inside the **nexus_web SharedWorker runtime** —
nexus debugging itself, not your code. The user invokes \`/debug\` when
something inside nexus is misbehaving (tool calls hang, the worker freezes,
streaming events arrive in the wrong order, a skill doesn't activate, etc.).

The recent runtime log is included below. Read it for the symptom the user
describes; investigate further with \`Read\`/\`Grep\` if you need to look at
nexus source.
${justEnabledSection}
${issueSection}

## Worker Log Status

${bufferStatus}

## Recent Worker Log (last ${DEFAULT_RECENT_ENTRIES})

These are \`console.warn\` / \`console.error\` calls plus uncaught
\`error\` / \`unhandledrejection\` events captured inside the SharedWorker
realm by \`workerLogBuffer\` (always-on), plus — while debug capture is
enabled — \`[debug]\`/\`[info]\` instrumentation from \`traceLine\`
(\`[tool]\` start/done pairs, \`[query]\` loop-iteration branches, \`[mcp]\`
connect lifecycle). The ring caps at 500 entries.

\`\`\`
${tail}
\`\`\`${bridgeSection}

## How to investigate

1. Identify the symptom in the log entries above — look for the user's
   reported issue first, then any other anomalies.
2. Use the timestamps to correlate related entries (an error and its
   trigger usually land within milliseconds). A \`[tool] … start\` line
   with no matching \`ok\`/\`soft-failed\`/\`threw\` line is the signature
   of a hung tool call; \`[query] loop-iter\` lines show what the agent
   loop decided each turn.
3. When you need to understand WHY something logged, read the source. The
   \`[tag]\` prefix in many entries (e.g. \`[mcp]\`, \`[bridge]\`) points at
   the module — search there first.
4. If the log is empty or the symptom isn't present, ask the user to
   reproduce the issue with the developer tools open, then re-run
   \`/debug\` — the buffer captures live activity.

## When to escalate

If you find an actual bug in nexus_web, summarise:
- What the user did (or what they reported).
- What the log shows happened.
- The root cause (with file:line citations).
- A suggested fix or workaround.
`
}

export function addDiagnoseSkill(): void {
  addStockSkill({
    name: 'debug',
    description:
      'Diagnose issues inside the nexus_web SharedWorker runtime (tool hangs, stream errors, skill activation failures, …). Reads the in-memory worker log buffer and bridge trace. Use when nexus itself is misbehaving — not for debugging your own project code.',
    argumentHint: '[issue description]',
    permittedTools: ['Read', 'Grep', 'Glob'],
    // No model surface, so the model doesn't waste context
    // describing nexus internals on every unrelated turn. The user
    // explicitly invokes `/debug` when they need diagnosis.
    modelInvocation: [],
    // Auto-registers feature `bundled-skills.debug`.
    default: false,
    featureTitle: 'Debug — diagnose runtime',
    featureDescription:
      'Adds /debug — diagnose issues INSIDE nexus_web (tool hangs, stream errors, skill activation failures). Reads the in-memory worker log buffer and bridge trace.',
    dynamicContent: async args => getDebugPrompt(args),
  })
}
