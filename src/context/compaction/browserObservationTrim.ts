import type { Message, UserRow, ModelReplyRow } from '../../runtime/RuntimeTypes.js'
import type { ToolCallContext } from '../../toolkit/toolCallContext.js'
import type { LightTrimOutcome } from '../../runtime/interfaces/QueryRuntimeDeps.js'
import {
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  PART_TEXT,
  PART_IMAGE,
  PART_DOCUMENT,
  isAssistantMessage,
  isUserMessage,
} from '../../runtime/VercelModelConstants.js'

// Browser-tool microcompact: before every `callModel`, rewrites the wire messages
// only, newest-to-oldest. 1. One-shot strip: per tool name, only the newest
// result keeps its extracted content. 2. Per-tab keep-newest: each `tab_id`'s
// newest snapshot keeps `elements[]`, up to `MAX_FULL_OBSERVATION_TABS` tabs;
// the rest become `{tab_id, summary | note}`, the summary from the reflection
// args of the call that first introduced the tab. Idempotent on placeholders.

// Every `Browser*` tool shares the observation shape, so a prefix predicate
// opts them in; `Done` has no observation.
function isCompactableTool(name: string): boolean {
  return name.startsWith('Browser') && name !== 'BrowserMediaState'
}
// Default set kept around for backward-compat with the factory's
// `compactableToolNames` override parameter — callers that pass an
// explicit list get exact-name matching; the default uses the
// predicate above.
const DEFAULT_COMPACTABLE_TOOL_NAMES: ReadonlySet<string> | null = null

const OBSERVATION_STRIPPED_NOTE =
  'Observation omitted to save tokens — a more recent turn carries the current page state, or re-observe if needed.'

// Wire tool name → top-level result field(s) of extracted content; every
// occurrence past the newest gets ONE_SHOT_STRIPPED_NOTE.
const ONE_SHOT_TOOL_FIELDS: Record<string, readonly string[]> = {
  BrowserReadPage: ['page_text'],
  BrowserReadElement: ['element_text'],
  BrowserFindText: ['matches'],
}

const ONE_SHOT_STRIPPED_NOTE =
  'Large extracted content omitted to save tokens — re-run the same action if you need it again.'

// Placeholder swapped in for an older BrowserScreenshot's image content
// part (base64 images are large; keep only the newest in-flight image).
const SCREENSHOT_IMAGE_STRIPPED_NOTE =
  'Screenshot image omitted to save tokens — re-run BrowserScreenshot if you need to see the page again.'

// Cap on how many distinct tabs may keep their newest observation
// full on the wire. Walking newest-to-oldest, the first
// `MAX_FULL_OBSERVATION_TABS` distinct `tab_id`s encountered get to
// keep their newest snapshot intact; every later (older) tab has its
// newest also stripped. Empirically tuned: 2 is enough for the
// typical "background tab + foreground tab" interaction pattern (a
// search results tab plus the article being read), and stops the
// wire from ballooning when the model spreads across many tabs.
const MAX_FULL_OBSERVATION_TABS = 2

// Tool-agnostic media budget, newest-to-oldest across the session: the newest
// media part is always kept; after it, parts are kept while the part and char
// budgets hold, and older ones become a one-line note. The part cap is the
// effective limit (media is billed natively, not by base64 length).
const MAX_LIVE_TOOL_MEDIA_PARTS = 2
const MAX_LIVE_TOOL_MEDIA_CHARS = 4_000_000

const STALE_TOOL_MEDIA_STRIPPED_NOTE =
  'Image omitted to save tokens — a more recent turn carries the images that are still live; re-read the file if you need to see this one again.'

/**
 * `liveMessage` is the index of the NEWEST message that carries media. Every
 * media part in that message is live — the model just asked for all of it,
 * e.g. three parallel `Read`s whose results were merged into one user message
 * — so the caps only apply to older messages. Without it the budget ran
 * oldest-to-newest WITHIN the message and replaced the third image with the
 * "omitted" note before the model ever saw it.
 */
type MediaBudget = { count: number; chars: number; liveMessage: number | null }

/**
 * Replace aged-out image/document parts of one tool result with a text note,
 * charging survivors against the shared `budget` (mutated). Idempotent; returns
 * the original block when nothing changed.
 */
function stripStaleMediaParts(
  block: any,
  budget: MediaBudget,
  rowPosition: number,
): any {
  // Both envelope shapes. A legacy `content`-shaped tool result (the shape
  // `normalizeMessageContentPartForBridge` still accepts) carries media just as
  // the canonical `result`-shaped one does, and reading only `result` left its
  // images riding every subsequent request for the rest of the session — the
  // precise bug this function exists to fix, on the other envelope. Matches
  // the `result`/`content` fallback every sibling path already does.
  const field = Array.isArray(block.result)
    ? 'result'
    : Array.isArray(block.content)
      ? 'content'
      : null
  if (!field) return block
  const parts = block[field] as any[]
  let modified = false
  const newParts = parts.map((part: any) => {
    if (!part || typeof part !== 'object') return part
    const payload =
      part.type === PART_IMAGE && typeof part.image === 'string'
        ? part.image
        : part.type === PART_DOCUMENT && typeof part.data === 'string'
          ? part.data
          : undefined
    if (payload === undefined) return part
    if (budget.liveMessage === null) budget.liveMessage = rowPosition
    const keep =
      budget.liveMessage === rowPosition ||
      (budget.count < MAX_LIVE_TOOL_MEDIA_PARTS &&
        budget.chars + payload.length <= MAX_LIVE_TOOL_MEDIA_CHARS)
    if (keep) {
      budget.count += 1
      budget.chars += payload.length
      return part
    }
    modified = true
    return { type: PART_TEXT, text: STALE_TOOL_MEDIA_STRIPPED_NOTE }
  })
  return modified ? { ...block, [field]: newParts } : block
}

/**
 * Charge already-kept media parts against the shared budget WITHOUT stripping
 * anything. The Browser* path decides an image's fate on tab liveness, not on
 * this budget, but an image it keeps is just as live on the wire as one
 * `stripStaleMediaParts` kept — leaving it uncharged let the declared cap leak
 * by however many browser screenshots were live, so a browser screenshot plus
 * two Read images put three media payloads on a wire whose cap says two.
 */
function chargeKeptMediaParts(
  parts: unknown[],
  budget: MediaBudget,
  rowPosition: number,
): void {
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    const payload =
      p.type === PART_IMAGE && typeof p.image === 'string'
        ? p.image
        : p.type === PART_DOCUMENT && typeof p.data === 'string'
          ? p.data
          : undefined
    if (payload === undefined) continue
    if (budget.liveMessage === null) budget.liveMessage = rowPosition
    budget.count += 1
    budget.chars += payload.length
  }
}

// Strip summaries come from the reflection args the model writes on every
// browser call (`evaluation_previous_goal`, `memory`, `next_goal`); without them
// the generic OBSERVATION_STRIPPED_NOTE is used.

// Compose a strip-summary string from the args of a single tool call.
// Prefers `next_goal` (the most concrete "what I tried") over `memory`
// (the broader scratchpad) — both are usually short and concrete. The
// composed string is a single line, capped at 800 chars to keep the
// stripped envelope small. Returns undefined when neither field is a
// non-empty string (e.g. older records, or non-browser tools
// that don't carry reflection fields).
function summaryFromReflectionArgs(
  args: unknown,
): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const a = args as Record<string, unknown>
  const nextGoal = typeof a.next_goal === 'string' ? a.next_goal.trim() : ''
  const memory = typeof a.memory === 'string' ? a.memory.trim() : ''
  if (!nextGoal && !memory) return undefined
  // Both present → join with a separator so the model sees what was
  // intended AND what it knew at the time. One present → use it
  // alone.
  let composed: string
  if (nextGoal && memory) {
    composed = `goal: ${nextGoal} | memory: ${memory}`
  } else {
    composed = nextGoal || memory
  }
  return composed.length > 800 ? composed.slice(0, 800) : composed
}

// Returns true if a single tab entry is already in its compact
// placeholder shape (`{tab_id, summary | note}`, no `elements[]`).
// Used to make per-tab stripping idempotent — re-running the strip on
// a persisted-and-restored compact result must be a no-op so amortized
// cost stays O(1).
function isAlreadyStrippedTab(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  if (Array.isArray(r.elements)) return false
  return typeof r.summary === 'string' || typeof r.note === 'string'
}

// Replace a single tab's `elements[]` with a `{tab_id, summary | note}`
// placeholder; `summary` replaces the generic note when given. Returns true if
// the tab changed shape. Idempotent on already-stripped placeholders.
function stripTabElements(
  tab: Record<string, unknown>,
  summary?: string,
): boolean {
  if (isAlreadyStrippedTab(tab)) return false
  if (!Array.isArray(tab.elements)) return false
  const tabId = typeof tab.tab_id === 'number' ? tab.tab_id : undefined
  // Strip everything tab-bound that would normally carry an
  // elements[]; replace with the minimal `{tab_id, summary | note}`
  // shape. When the caller provides a `summary` derived
  // from the model's own `next_goal` / `memory` args (the restored
  // reflection fields), use it as the replacement — it's a better
  // navigational hint than the generic note because it's the model's
  // own description of what that call was trying to do.
  for (const key of Object.keys(tab)) {
    delete (tab as Record<string, unknown>)[key]
  }
  tab.tab_id = tabId
  if (summary !== undefined && summary.length > 0) {
    tab.summary = summary
  } else {
    tab.note = OBSERVATION_STRIPPED_NOTE
  }
  return true
}

// Strip the top-level extracted-content field(s) on the parsed result
// envelope. BrowserReadPage / BrowserReadElement /
// BrowserFindText each carry their extracted content at the top level
// (`page_text` / `element_text` / `matches` respectively).
// Returns true if any field was actually rewritten so the caller knows
// to re-serialize. Idempotent: if the field is already the strip
// placeholder string, no-op.
function stripExtractedContentFields(
  parsed: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  let modified = false
  for (const field of fields) {
    const current = parsed[field]
    if (current === undefined) continue
    // Already-stripped placeholder check: the strip overwrites with a
    // short string, so a string value matching the canonical
    // placeholder means we already ran the strip on a prior pass.
    if (typeof current === 'string' && current === ONE_SHOT_STRIPPED_NOTE) {
      continue
    }
    parsed[field] = ONE_SHOT_STRIPPED_NOTE
    modified = true
  }
  return modified
}

// Per-tab keep-newest strip over `parsed.observation.tabs[]`, shared by the
// string and screenshot paths; mutates `parsed` and `seenObservationTabIds`.
// Returns `windowStripped` (a tab was collapsed) and `elementsTabKept` (a tab
// with `elements[]` stayed full; the screenshot keeps its image only then).
function stripObservationTabs(
  parsed: Record<string, unknown>,
  ctx: {
    seenObservationTabIds: Set<number>
    tabBirthSummary: Map<number, string>
    fallbackSummary: string | undefined
  },
): { windowStripped: boolean; elementsTabKept: boolean } {
  let windowStripped = false
  let elementsTabKept = false
  const observation = parsed.observation
  if (
    !observation ||
    typeof observation !== 'object' ||
    Array.isArray(observation)
  ) {
    return { windowStripped, elementsTabKept }
  }
  const tabs = (observation as Record<string, unknown>).tabs
  if (!Array.isArray(tabs)) {
    return { windowStripped, elementsTabKept }
  }
  for (const tab of tabs as unknown[]) {
    if (!tab || typeof tab !== 'object' || Array.isArray(tab)) continue
    const tabRecord = tab as Record<string, unknown>
    const tabId =
      typeof tabRecord.tab_id === 'number' ? tabRecord.tab_id : undefined
    if (tabId === undefined) continue
    // Only a tab carrying a real elements[] array is a full snapshot that
    // competes for a keep-newest slot. A tab without one — basics-only
    // (T0-b read_page/find_text), an `{unchanged, count}` short-circuit
    // stub (T0-c), a non-working tab, or an already-stripped placeholder —
    // has nothing to strip and MUST NOT occupy a slot: doing so would push
    // an older FULL snapshot of the same tab (or of another tab) out to a
    // placeholder even though this entry never carried the live snapshot.
    // (Fix A / C3.)
    if (!Array.isArray(tabRecord.elements)) continue
    const alreadySeen = ctx.seenObservationTabIds.has(tabId)
    const capReached =
      ctx.seenObservationTabIds.size >= MAX_FULL_OBSERVATION_TABS
    if (alreadySeen || capReached) {
      const tabSummary = ctx.tabBirthSummary.get(tabId) ?? ctx.fallbackSummary
      if (stripTabElements(tabRecord, tabSummary)) {
        windowStripped = true
      }
    } else {
      ctx.seenObservationTabIds.add(tabId)
      elementsTabKept = true
    }
  }
  return { windowStripped, elementsTabKept }
}

export function createBrowserToolMicrocompact(
  compactableToolNames?: string[],
) {
  // Caller-supplied explicit list → exact-name set matching. Default
  // (no list provided) → predicate matching on `Browser*` prefix
  // (catches new tools without a code change here).
  const explicitToolNameSet =
    compactableToolNames && compactableToolNames.length > 0
      ? new Set(compactableToolNames)
      : null
  const isCompactable = (name: string): boolean =>
    explicitToolNameSet ? explicitToolNameSet.has(name) : isCompactableTool(name)
  // Silence unused-symbol warning if some future caller drops the
  // explicit-set path.
  void DEFAULT_COMPACTABLE_TOOL_NAMES

  return async function microcompact(
    messages: Message[],
    _toolUseContext: ToolCallContext,
    _querySource: string,
  ): Promise<LightTrimOutcome> {
    const strippedToolCallIds = new Map<string, string>()

    // Tool name lookup table: tool_call_id → tool_name. Built from the
    // assistant turns first so the tool_result pass can dispatch by
    // tool name without a quadratic scan.
    const toolUseMap = new Map<string, string>()
    // tool_call_id → composed reflection summary
    // (`next_goal` / `memory` from the assistant's tool-call args).
    // Looked up during the strip pass to populate the per-tab
    // `summary` placeholder, replacing the generic
    // OBSERVATION_STRIPPED_NOTE with a model-authored description of
    // what that historical call was trying to do.
    const reflectionByToolCallId = new Map<string, string>()
    for (const msg of messages) {
      if (!isAssistantMessage(msg)) continue
      const content = (msg as ModelReplyRow).message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          block.type === PART_TOOL_CALL &&
          typeof block.toolCallId === 'string' &&
          typeof block.toolName === 'string'
        ) {
          toolUseMap.set(block.toolCallId, block.toolName)
          // Capture the model-authored reflection args
          // (`next_goal` / `memory`) so the strip pass can use them
          // as the per-tab strip placeholder. Block shape varies by
          // model SDK — args may live under `args` or `arguments`
          // depending on the provider's translation. Try both. If
          // neither resolves to a useful summary, the strip falls
          // back to OBSERVATION_STRIPPED_NOTE for this toolCallId.
          const blockRecord = block as Record<string, unknown>
          const argsRaw =
            blockRecord.args !== undefined
              ? blockRecord.args
              : blockRecord.arguments
          const summary = summaryFromReflectionArgs(argsRaw)
          if (summary !== undefined) {
            reflectionByToolCallId.set(block.toolCallId, summary)
          }
        }
      }
    }

    // Per-tab "birth" summary: the reflection of the earliest call that mentioned
    // each tab (oldest-to-newest, set-if-absent), used as its strip placeholder.
    const tabBirthSummary = new Map<number, string>()
    for (const msg of messages) {
      if (!isUserMessage(msg)) continue
      const content = (msg as UserRow).message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (
          !block ||
          typeof block !== 'object' ||
          (block as { type?: unknown }).type !== PART_TOOL_RESULT_CANONICAL ||
          typeof (block as { toolCallId?: unknown }).toolCallId !== 'string'
        ) {
          continue
        }
        const blockRecord = block as Record<string, unknown>
        const callId = blockRecord.toolCallId as string
        const summary = reflectionByToolCallId.get(callId)
        if (summary === undefined) continue
        const resultField =
          typeof blockRecord.result === 'string'
            ? 'result'
            : typeof blockRecord.content === 'string'
              ? 'content'
              : null
        if (!resultField) continue
        let parsed: Record<string, unknown>
        try {
          const obj = JSON.parse(blockRecord[resultField] as string)
          if (!obj || typeof obj !== 'object') continue
          parsed = obj as Record<string, unknown>
        } catch {
          continue
        }
        const observation = parsed.observation
        if (
          !observation ||
          typeof observation !== 'object' ||
          Array.isArray(observation)
        ) {
          continue
        }
        const tabs = (observation as Record<string, unknown>).tabs
        if (!Array.isArray(tabs)) continue
        for (const tab of tabs as unknown[]) {
          if (!tab || typeof tab !== 'object' || Array.isArray(tab)) continue
          const tabRecord = tab as Record<string, unknown>
          const tabId =
            typeof tabRecord.tab_id === 'number' ? tabRecord.tab_id : undefined
          if (tabId === undefined) continue
          // Set-if-absent: the FIRST mention of this tab in oldest-to-
          // newest order wins. Captures what the model was doing when
          // tab N was created/introduced into the session, which is
          // the most accurate identity for tab N.
          if (!tabBirthSummary.has(tabId)) {
            tabBirthSummary.set(tabId, summary)
          }
        }
      }
    }

    const processed: Message[] = []

    // Tabs already kept full, newest-to-oldest; past `MAX_FULL_OBSERVATION_TABS` a
    // new tab is stripped too.
    const seenObservationTabIds = new Set<number>()
    // Shared across every message in the walk so "newest" is session-wide.
    const mediaBudget: MediaBudget = { count: 0, chars: 0, liveMessage: null }
    // Per-tool one-shot counter
    // (`include_extracted_content_only_once`). The first occurrence of
    // each one-shot tool (BrowserReadPage / BrowserReadElement /
    // BrowserFindText) walking newest-to-oldest keeps its content;
    // every later occurrence gets the top-level field swapped for the
    // strip placeholder.
    const oneShotSeenByToolName = new Map<string, number>()

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (!isUserMessage(msg)) {
        processed.unshift(msg)
        continue
      }
      const content = (msg as UserRow).message?.content
      if (!Array.isArray(content)) {
        processed.unshift(msg)
        continue
      }

      let hasModifiedBlocks = false
      const newContent = content.map((block: any) => {
        if (
          !block ||
          typeof block !== 'object' ||
          block.type !== PART_TOOL_RESULT_CANONICAL ||
          typeof block.toolCallId !== 'string'
        ) {
          return block
        }

        const toolName = toolUseMap.get(block.toolCallId)
        if (!toolName || !isCompactable(toolName)) {
          // Non-Browser tool: the tab-aware image strip in pass (0) does not
          // apply, but its media parts still have to age out or they ride
          // the wire forever. Newest-to-oldest, so the budget keeps the most
          // recent images and drops what the model has moved on from.
          const budgeted = stripStaleMediaParts(block, mediaBudget, i)
          if (budgeted !== block) hasModifiedBlocks = true
          return budgeted
        }

        // (0) Screenshot result `[text observation, image]`: the image is kept only
        //     while the same per-tab strip keeps its tab full (`elementsTabKept`).
        if (Array.isArray(block.result)) {
          const parts = block.result as Array<Record<string, unknown> | null>
          const hasImage = parts.some(
            p => p && typeof p === 'object' && p.type === PART_IMAGE,
          )
          const fallbackSummary = reflectionByToolCallId.get(block.toolCallId)
          let elementsTabKept = false
          let textRewritten = false
          const newParts = parts.map(p => {
            if (
              p &&
              typeof p === 'object' &&
              p.type === PART_TEXT &&
              typeof p.text === 'string'
            ) {
              try {
                const parsed = JSON.parse(p.text)
                if (parsed && typeof parsed === 'object') {
                  const r = stripObservationTabs(
                    parsed as Record<string, unknown>,
                    { seenObservationTabIds, tabBirthSummary, fallbackSummary },
                  )
                  if (r.elementsTabKept) elementsTabKept = true
                  if (r.windowStripped) {
                    textRewritten = true
                    return { ...p, text: JSON.stringify(parsed) }
                  }
                }
              } catch {
                // Not JSON — leave the text part untouched.
              }
            }
            return p
          })
          // Strip the image once its observation is no longer live.
          const imageStripped = !elementsTabKept && hasImage
          const finalParts = imageStripped
            ? newParts.map(p =>
                p && typeof p === 'object' && p.type === PART_IMAGE
                  ? { type: PART_TEXT, text: SCREENSHOT_IMAGE_STRIPPED_NOTE }
                  : p,
              )
            : newParts
          // Whatever survived here is live on the wire, so it counts against
          // the same cap the non-Browser path enforces.
          chargeKeptMediaParts(finalParts as unknown[], mediaBudget, i)
          if (!textRewritten && !imageStripped) return block
          hasModifiedBlocks = true
          return { ...block, result: finalParts }
        }

        const resultField =
          typeof block.result === 'string'
            ? 'result'
            : typeof block.content === 'string'
              ? 'content'
              : null
        if (!resultField) return block
        const rawContent = block[resultField] as string

        // Tool_result body is pure JSON. The C++ host's `wait_synthesis_cause`
        // path used to wrap soft-recovery results in a leading
        // `<system-reminder>...</system-reminder>\n\n{json}` text block, but
        // that was dropped (cross-provider portability — the tag was
        // vendor-specific and didn't help on other providers, and it
        // also broke the soft-failure detector in engine/turnLoop.ts). Soft-
        // recovery now lives as a structured `error.code` field inside
        // the JSON body itself. JSON.parse should always succeed.
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(rawContent)
          if (!parsed || typeof parsed !== 'object') return block
        } catch {
          return block
        }

        // (1) One-shot extracted-content strip: only the newest same-tool result keeps
        //     its content.
        let oneShotStripped = false
        const oneShotFields = ONE_SHOT_TOOL_FIELDS[toolName]
        if (oneShotFields) {
          const seen = oneShotSeenByToolName.get(toolName) ?? 0
          oneShotSeenByToolName.set(toolName, seen + 1)
          if (seen >= 1) {
            oneShotStripped = stripExtractedContentFields(parsed, oneShotFields)
          }
        }

        // (2) Per-tab keep-newest strip, sharing one window with the screenshot path.
        //     Placeholders use the tab's birth summary, else this call's reflection.
        const fallbackSummary = reflectionByToolCallId.get(block.toolCallId)
        const { windowStripped } = stripObservationTabs(parsed, {
          seenObservationTabIds,
          tabBirthSummary,
          fallbackSummary,
        })

        // (3) When the per-tab strip changed any tab in this result,
        //     ALSO strip the top-level extracted-content fields
        //     (page_text / element_text / matches) IF this result's
        //     tool is one of the one-shot kinds. The model can't
        //     usefully consult the extracted content from an aged-out
        //     observation; keeping the byte-heavy field around just
        //     burns tokens.
        if (windowStripped && oneShotFields) {
          stripExtractedContentFields(parsed, oneShotFields)
        }

        if (!oneShotStripped && !windowStripped) return block
        hasModifiedBlocks = true
        const compactContent = JSON.stringify(parsed)
        strippedToolCallIds.set(block.toolCallId, compactContent)
        return { ...block, [resultField]: compactContent }
      })

      if (hasModifiedBlocks) {
        processed.unshift({
          ...msg,
          message: {
            ...(msg as UserRow).message,
            content: newContent,
          },
        } as UserRow)
      } else {
        processed.unshift(msg)
      }
    }

    return {
      messages: processed,
      strippedToolCallIds:
        strippedToolCallIds.size > 0 ? strippedToolCallIds : undefined,
    }
  }
}
