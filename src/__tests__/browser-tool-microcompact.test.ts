import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import { createBrowserToolMicrocompact } from '../context/compaction/browserObservationTrim'
import {
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  PART_TEXT,
  PART_IMAGE,
} from '../runtime/VercelModelConstants'
import type { ToolCallContext } from '../toolkit/toolCallContext'

// ---------------------------------------------------------------------------
// Microcompact tests — flat-tool schema: each `Browser*` tool returns `{action, ok, observation: {tabs}}`, plus
// top-level extracted content (`page_text` / `element_text` / `matches`) on the three one-shot tools.
//   1. Older one-shot results get ONE_SHOT_STRIPPED_NOTE; the newest stays full.
//   2. Per-tab keep-newest observation strip, newest-to-oldest, with a max-tabs cap (=2).
//   3. When the per-tab strip fires on a one-shot tool, its extracted-content fields are stripped too.
// ---------------------------------------------------------------------------

const STUB_CTX = {} as ToolCallContext

// Matches the constants in src/context/compaction/browserObservationTrim.ts.
// Duplicated here intentionally so a future copy-edit on the placeholder
// string flips the test red instead of silently passing.
const ONE_SHOT_STRIPPED_NOTE =
  'Large extracted content omitted to save tokens — re-run the same action if you need it again.'
const OBSERVATION_STRIPPED_NOTE =
  'Observation omitted to save tokens — a more recent turn carries the current page state, or re-observe if needed.'

// Canonical-form helpers (Vercel AI SDK shape). The toolName is passed
// explicitly because microcompact dispatches off it; defaults to a generic
// Browser* tool that triggers the observation strip but no one-shot logic.
function canonicalAssistantToolUse(
  toolCallId: string,
  toolName = 'BrowserClick',
  args: Record<string, unknown> = {},
): Message {
  return {
    type: 'assistant',
    uuid: `a-${toolCallId}`,
    message: {
      role: 'assistant',
      content: [
        { type: PART_TOOL_CALL, toolCallId, toolName, args },
      ],
    },
  } as Message
}

function canonicalToolResult(
  toolCallId: string,
  result: Record<string, unknown>,
): Message {
  return {
    type: 'user',
    uuid: `u-${toolCallId}`,
    message: {
      role: 'user',
      content: [
        {
          type: PART_TOOL_RESULT_CANONICAL,
          toolCallId,
          result: JSON.stringify(result),
        },
      ],
    },
  } as Message
}

function followUpUser(): Message {
  return {
    type: 'user',
    uuid: 'u-followup',
    message: { role: 'user', content: 'next' },
  } as Message
}

function getResultJson(
  message: Message | undefined,
): Record<string, unknown> | null {
  const inner = (message as { message?: { content?: unknown } } | undefined)
    ?.message
  if (!inner) return null
  const content = (inner as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === PART_TOOL_RESULT_CANONICAL
    ) {
      const raw = (block as { result?: unknown }).result
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

// Build an observation envelope with one or more `observation.tabs[]`
// entries, each carrying its own `elements[]` array. Used by both the
// per-tab strip tests AND the one-shot strip tests (which still need an
// observation present so the per-tab walker can see the tab_id).
function observationEnvelope(tabs: Array<{
  tab_id: number
  url?: string
  title?: string
  elements?: Array<Record<string, unknown>>
}>): Record<string, unknown> {
  return {
    tabs: tabs.map(t => ({
      tab_id: t.tab_id,
      url: t.url ?? `https://example.com/${t.tab_id}`,
      title: t.title ?? `Tab ${t.tab_id}`,
      elements: t.elements ?? [
        { index: 100, type: 'link', text: 'Link A' },
        { index: 101, type: 'link', text: 'Link B' },
        { index: 102, type: 'form_control', text: 'Search' },
      ],
    })),
  }
}

// ===========================================================================
// Group 1 — one-shot extracted-content strip (page_text / element_text /
// matches at the top level of the parsed envelope, keyed off the LLM-facing
// tool name).
// ===========================================================================

describe('one-shot extracted-content strip', () => {
  it('strips page_text on the older BrowserReadPage occurrence', async () => {
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('a1', 'BrowserReadPage'),
      canonicalToolResult('a1', {
        action: 'read_page',
        ok: true,
        page_text: 'older page_text — must disappear',
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      canonicalAssistantToolUse('a2', 'BrowserReadPage'),
      canonicalToolResult('a2', {
        action: 'read_page',
        ok: true,
        page_text: 'newer page_text — must stay',
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    const older = getResultJson(out.messages[1])
    const newer = getResultJson(out.messages[3])

    expect(older?.page_text).toBe(ONE_SHOT_STRIPPED_NOTE)
    expect(newer?.page_text).toBe('newer page_text — must stay')
  })

  it('strips matches on the older BrowserFindText occurrence', async () => {
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('a1', 'BrowserFindText'),
      canonicalToolResult('a1', {
        action: 'find_text',
        ok: true,
        matches: [{ text: 'older' }],
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      canonicalAssistantToolUse('a2', 'BrowserFindText'),
      canonicalToolResult('a2', {
        action: 'find_text',
        ok: true,
        matches: [{ text: 'newer' }],
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    const older = getResultJson(out.messages[1])
    const newer = getResultJson(out.messages[3])

    // Older: matches replaced by the strip placeholder string.
    expect(older?.matches).toBe(ONE_SHOT_STRIPPED_NOTE)
    // Newest: matches stays as the original array.
    expect(Array.isArray(newer?.matches)).toBe(true)
  })

  it('counts one-shot occurrences PER tool name independently', async () => {
    // BrowserClick interleaves between two BrowserReadPage calls. The
    // counter is keyed by tool name, so the click doesn't perturb the
    // page_text strip — the older BrowserReadPage still strips because
    // a newer BrowserReadPage exists.
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('a1', 'BrowserReadPage'),
      canonicalToolResult('a1', {
        action: 'read_page',
        ok: true,
        page_text: 'older read_page text',
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      canonicalAssistantToolUse('a2', 'BrowserClick'),
      canonicalToolResult('a2', {
        action: 'click',
        ok: true,
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      canonicalAssistantToolUse('a3', 'BrowserReadPage'),
      canonicalToolResult('a3', {
        action: 'read_page',
        ok: true,
        page_text: 'newer read_page text',
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    // Older read_page (a1) — page_text stripped.
    expect(getResultJson(out.messages[1])?.page_text).toBe(ONE_SHOT_STRIPPED_NOTE)
    // Newer read_page (a3) — page_text kept.
    expect(getResultJson(out.messages[5])?.page_text).toBe('newer read_page text')
  })
})

// ===========================================================================
// Group 2 — per-tab keep-newest observation strip with a max-tabs cap (=2).
// ===========================================================================

describe('per-tab keep-newest observation strip', () => {
  function observationResult(
    callId: string,
    tabId: number,
    nextGoal?: string,
  ): Message {
    return canonicalToolResult(callId, {
      action: 'click',
      ok: true,
      observation: observationEnvelope([{ tab_id: tabId }]),
      // legacy long_term_memory has no effect — the strip
      // pulls its placeholder text from the assistant turn's `next_goal`
      // / `memory` args. Pass it via the assistant helper instead.
      ...(nextGoal ? { long_term_memory: nextGoal } : {}),
    })
  }

  function observationAssistant(callId: string, nextGoal?: string): Message {
    return canonicalAssistantToolUse(
      callId,
      'BrowserClick',
      nextGoal ? { next_goal: nextGoal } : {},
    )
  }

  it('strips every older observation of the same tab, keeps the newest full', async () => {
    // Four turns all on tab_id=11. Walking newest-to-oldest, turn 4 is
    // the newest sighting of tab 11 and stays full. Turns 1/2/3 are
    // older sightings of the same tab — strip each tab to its placeholder.
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      observationAssistant('a1', "Searched Google for 'X'"),
      observationResult('a1', 11),
      observationAssistant('a2', "Searched Google for 'Y'"),
      observationResult('a2', 11),
      observationAssistant('a3', 'Clicked element 1022'),
      observationResult('a3', 11),
      observationAssistant('a4', "Searched Google for 'Z'"),
      observationResult('a4', 11),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    const r1 = getResultJson(out.messages[1])
    const r2 = getResultJson(out.messages[3])
    const r3 = getResultJson(out.messages[5])
    const r4 = getResultJson(out.messages[7])

    // Per-tab summary comes from the FIRST call that introduced the tab
    // (birth-summary), not from the current call. So all
    // three older sightings of tab 11 carry the a1 next_goal as their
    // tab summary.
    for (const [name, parsed] of [
      ['turn 1', r1],
      ['turn 2', r2],
      ['turn 3', r3],
    ] as const) {
      const tabs = (parsed?.observation as Record<string, unknown>)?.tabs as
        | Array<Record<string, unknown>>
        | undefined
      expect(tabs?.[0]?.elements, `${name}: elements removed`).toBeUndefined()
      expect(tabs?.[0]?.tab_id, `${name}: tab_id preserved`).toBe(11)
      expect(tabs?.[0]?.summary, `${name}: birth summary stamped`).toBe(
        "Searched Google for 'X'",
      )
    }

    // Newest sighting of tab 11 stays full.
    const tabs4 = (r4?.observation as Record<string, unknown>)?.tabs as
      | Array<Record<string, unknown>>
      | undefined
    expect(Array.isArray(tabs4?.[0]?.elements)).toBe(true)
    expect((tabs4?.[0]?.elements as unknown[]).length).toBe(3)
    expect(tabs4?.[0]?.tab_id).toBe(11)
  })

  it('keeps the newest observation full PER tab when the model spans multiple tabs', async () => {
    // Walk: a1 tab 11, a2 tab 12, a3 tab 11 (revisit), a4 tab 12 (revisit).
    // Walking newest-to-oldest:
    //   a4 (tab 12) — first sighting of tab 12 → keep full
    //   a3 (tab 11) — first sighting of tab 11 → keep full
    //   a2 (tab 12) — older sighting of tab 12 → strip
    //   a1 (tab 11) — older sighting of tab 11 → strip
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      observationAssistant('a1', 'tab11 visit 1'),
      observationResult('a1', 11),
      observationAssistant('a2', 'tab12 visit 1'),
      observationResult('a2', 12),
      observationAssistant('a3', 'tab11 visit 2'),
      observationResult('a3', 11),
      observationAssistant('a4', 'tab12 visit 2'),
      observationResult('a4', 12),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    // Older sightings of each tab — stripped, with the birth summary
    // (the tab's FIRST-mention reflection wins).
    const r1 = getResultJson(out.messages[1]) // tab 11 older
    const r2 = getResultJson(out.messages[3]) // tab 12 older
    const tabs1 = (r1?.observation as Record<string, unknown>)?.tabs as
      | Array<Record<string, unknown>>
      | undefined
    const tabs2 = (r2?.observation as Record<string, unknown>)?.tabs as
      | Array<Record<string, unknown>>
      | undefined
    expect(tabs1?.[0]?.elements).toBeUndefined()
    expect(tabs1?.[0]?.tab_id).toBe(11)
    expect(tabs1?.[0]?.summary).toBe('tab11 visit 1')
    expect(tabs2?.[0]?.elements).toBeUndefined()
    expect(tabs2?.[0]?.tab_id).toBe(12)
    expect(tabs2?.[0]?.summary).toBe('tab12 visit 1')

    // Newest sighting of each tab — full.
    const r3 = getResultJson(out.messages[5]) // tab 11 newest
    const r4 = getResultJson(out.messages[7]) // tab 12 newest
    const tabs3 = (r3?.observation as Record<string, unknown>)?.tabs as
      | Array<Record<string, unknown>>
      | undefined
    const tabs4 = (r4?.observation as Record<string, unknown>)?.tabs as
      | Array<Record<string, unknown>>
      | undefined
    expect(Array.isArray(tabs3?.[0]?.elements)).toBe(true)
    expect(tabs3?.[0]?.tab_id).toBe(11)
    expect(Array.isArray(tabs4?.[0]?.elements)).toBe(true)
    expect(tabs4?.[0]?.tab_id).toBe(12)
  })

  it('caps full snapshots at MAX_FULL_OBSERVATION_TABS (=2): only the 2 most-recently-touched tabs keep elements, older tabs strip', async () => {
    // Walk: a1 tab 11, a2 tab 12, a3 tab 13. Three distinct tabs,
    // each touched exactly once. Walking newest-to-oldest:
    //   a3 (tab 13) — slot 1/2 → keep full
    //   a2 (tab 12) — slot 2/2 → keep full
    //   a1 (tab 11) — cap reached, this tab is the 3rd-most-recently-
    //                  touched → strip even though it's tab 11's newest
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      observationAssistant('a1', 'Visited tab 11 (oldest, beyond cap)'),
      observationResult('a1', 11),
      observationAssistant('a2', 'Visited tab 12'),
      observationResult('a2', 12),
      observationAssistant('a3', 'Visited tab 13 (newest)'),
      observationResult('a3', 13),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    // Tab 11 got stripped despite being its tab's newest — beyond the cap.
    const r1 = getResultJson(out.messages[1])
    const tabs1 = (r1?.observation as Record<string, unknown>)?.tabs as
      | Array<Record<string, unknown>>
      | undefined
    expect(tabs1?.[0]?.elements, 'tab 11 stripped — beyond cap').toBeUndefined()
    expect(tabs1?.[0]?.tab_id).toBe(11)
    expect(tabs1?.[0]?.summary).toBe('Visited tab 11 (oldest, beyond cap)')

    // Tab 12 kept full (slot 2/2).
    const r2 = getResultJson(out.messages[3])
    const tabs2 = (r2?.observation as Record<string, unknown>)?.tabs as
      | Array<Record<string, unknown>>
      | undefined
    expect(Array.isArray(tabs2?.[0]?.elements)).toBe(true)
    expect(tabs2?.[0]?.tab_id).toBe(12)

    // Tab 13 kept full (slot 1/2).
    const r3 = getResultJson(out.messages[5])
    const tabs3 = (r3?.observation as Record<string, unknown>)?.tabs as
      | Array<Record<string, unknown>>
      | undefined
    expect(Array.isArray(tabs3?.[0]?.elements)).toBe(true)
    expect(tabs3?.[0]?.tab_id).toBe(13)
  })

  it('cap counts distinct tabs, not turns: 5 turns over 2 tabs still keeps both', async () => {
    // 5 turns, alternating tabs 11/12. Even though there are 5
    // observations, only 2 distinct tabs → both newest sightings stay
    // full (the cap is "distinct tabs", not "total full snapshots").
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      observationAssistant('a1', 'tab11 visit 1'),
      observationResult('a1', 11),
      observationAssistant('a2', 'tab12 visit 1'),
      observationResult('a2', 12),
      observationAssistant('a3', 'tab11 visit 2'),
      observationResult('a3', 11),
      observationAssistant('a4', 'tab12 visit 2'),
      observationResult('a4', 12),
      observationAssistant('a5', 'tab11 visit 3 (newest)'),
      observationResult('a5', 11),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    const tabsAt = (idx: number) =>
      (getResultJson(out.messages[idx])?.observation as Record<string, unknown>)
        ?.tabs as Array<Record<string, unknown>> | undefined

    // a5 (tab 11 newest) — full.
    expect(Array.isArray(tabsAt(9)?.[0]?.elements)).toBe(true)
    expect(tabsAt(9)?.[0]?.tab_id).toBe(11)

    // a4 (tab 12 newest) — full.
    expect(Array.isArray(tabsAt(7)?.[0]?.elements)).toBe(true)
    expect(tabsAt(7)?.[0]?.tab_id).toBe(12)

    // a3 (tab 11 older) — stripped.
    expect(tabsAt(5)?.[0]?.elements).toBeUndefined()

    // a2 (tab 12 older) — stripped.
    expect(tabsAt(3)?.[0]?.elements).toBeUndefined()

    // a1 (tab 11 oldest) — stripped.
    expect(tabsAt(1)?.[0]?.elements).toBeUndefined()
  })

  it('falls back to legacy note when reflection args are missing', async () => {
    // Same tab_id across both turns (so the older one strips), no
    // next_goal/memory in either assistant turn → strip uses the
    // OBSERVATION_STRIPPED_NOTE fallback string.
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('a1', 'BrowserClick'),
      canonicalToolResult('a1', {
        action: 'click',
        ok: true,
        observation: observationEnvelope([{
          tab_id: 7,
          elements: [{ index: 1, type: 'link', text: 'A' }],
        }]),
      }),
      canonicalAssistantToolUse('a2', 'BrowserClick'),
      canonicalToolResult('a2', {
        action: 'click',
        ok: true,
        observation: observationEnvelope([{
          tab_id: 7,
          elements: [{ index: 2, type: 'link', text: 'B' }],
        }]),
      }),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')
    const older = getResultJson(out.messages[1])
    const tabs = (older?.observation as Record<string, unknown>)?.tabs as
      | Array<Record<string, unknown>>
      | undefined
    expect(tabs?.[0]?.elements).toBeUndefined()
    expect(String(tabs?.[0]?.note)).toBe(OBSERVATION_STRIPPED_NOTE)
  })

  it('is idempotent — re-running on already-stripped output produces no further changes', async () => {
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('a1', 'BrowserClick', { next_goal: 'visit 1' }),
      canonicalToolResult('a1', {
        action: 'click',
        ok: true,
        observation: observationEnvelope([{ tab_id: 11 }]),
      }),
      canonicalAssistantToolUse('a2', 'BrowserClick', { next_goal: 'visit 2' }),
      canonicalToolResult('a2', {
        action: 'click',
        ok: true,
        observation: observationEnvelope([{ tab_id: 11 }]),
      }),
      followUpUser(),
    ]
    const firstPass = await microcompact(messages, STUB_CTX, 'sdk')
    const secondPass = await microcompact(firstPass.messages, STUB_CTX, 'sdk')

    expect(firstPass.strippedToolCallIds?.has('a1')).toBe(true)
    // Second pass on the same output: no further ids stripped.
    expect(secondPass.strippedToolCallIds?.has('a1') ?? false).toBe(false)

    const a1FromFirst = getResultJson(firstPass.messages[1])
    const a1FromSecond = getResultJson(secondPass.messages[1])
    expect(a1FromSecond).toEqual(a1FromFirst)
  })

  it('keeps a single observation full when the model only ever visits one tab', async () => {
    // Single-turn fixture: tab 11's only observation is its own newest →
    // stays full.
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      observationAssistant('a1', "Searched Google for 'X'"),
      observationResult('a1', 11),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')
    const tabs = (getResultJson(out.messages[1])?.observation as
      | Record<string, unknown>
      | undefined)
      ?.tabs as Array<Record<string, unknown>> | undefined
    expect(Array.isArray(tabs?.[0]?.elements)).toBe(true)
  })

  it('does not strip a non-observation tool_result (no parsed.observation)', async () => {
    // A `done` action (or any tool result without an observation dict)
    // must not affect the per-tab walk and must not be stripped (no
    // observation to strip in the first place).
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      observationAssistant('a1', "Searched Google for 'X'"),
      observationResult('a1', 11),
      canonicalAssistantToolUse('a2', 'BrowserDone'),
      canonicalToolResult('a2', {
        action: 'done',
        ok: true,
        is_done: true,
        success: true,
        text: 'Finished',
      }),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')
    const tabs = (getResultJson(out.messages[1])?.observation as
      | Record<string, unknown>
      | undefined)
      ?.tabs as Array<Record<string, unknown>> | undefined
    // tab 11's only observation in the trace stays full.
    expect(Array.isArray(tabs?.[0]?.elements)).toBe(true)
  })
})


// ===========================================================================
// Group 3 — a result whose per-tab observation is stale has its one-shot fields stripped too, even with no
// newer same-tool occurrence.
// ===========================================================================
describe('inner one-shot strip on stale outer observation', () => {
  const HUGE_PAGE_TEXT = '百度首页\n设置\n登录\nlots of body text...'.repeat(80)

  it('strips a single BrowserReadPage page_text when its outer observation is stale', async () => {
    // Single read_page early in the run, then 3 click turns on the same
    // tab. Pre-fix: the read_page is the "newest BrowserReadPage" (only
    // one), so its page_text survives. Post-fix: the outer per-tab
    // strip fires (older same-tab sighting), so the inner page_text is
    // also stripped because BrowserReadPage is a one-shot tool.
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('a1', 'BrowserReadPage', {
        next_goal: 'Read page baidu.com 3000 chars',
      }),
      canonicalToolResult('a1', {
        action: 'read_page',
        ok: true,
        page_text: HUGE_PAGE_TEXT,
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      canonicalAssistantToolUse('a2', 'BrowserClick', {
        next_goal: 'Clicked element 47',
      }),
      canonicalToolResult('a2', {
        action: 'click',
        ok: true,
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      canonicalAssistantToolUse('a3', 'BrowserClick', {
        next_goal: 'Clicked element 22',
      }),
      canonicalToolResult('a3', {
        action: 'click',
        ok: true,
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      canonicalAssistantToolUse('a4', 'BrowserClick', {
        next_goal: 'Clicked element 99',
      }),
      canonicalToolResult('a4', {
        action: 'click',
        ok: true,
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    // (1) Older read_page result: outer per-tab observation stripped.
    const r1 = getResultJson(out.messages[1])
    const tabs = (r1?.observation as Record<string, unknown>)?.tabs as
      | Array<Record<string, unknown>>
      | undefined
    expect(tabs?.[0]?.elements, 'outer stripped').toBeUndefined()
    expect(tabs?.[0]?.tab_id).toBe(5)

    // (2) Inner page_text also stripped — Group 3 contract.
    expect(r1?.page_text).toBe(ONE_SHOT_STRIPPED_NOTE)
  })

  it('keeps page_text intact when read_page IS the newest same-tab observation', async () => {
    // Two-turn fixture where the read_page is itself the newest result.
    // Inner page_text must survive — this is the agent's current
    // working context.
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('a1', 'BrowserClick', {
        next_goal: 'Clicked search button',
      }),
      canonicalToolResult('a1', {
        action: 'click',
        ok: true,
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      canonicalAssistantToolUse('a2', 'BrowserReadPage', {
        next_goal: 'Read page newest 3000 chars',
      }),
      canonicalToolResult('a2', {
        action: 'read_page',
        ok: true,
        page_text: HUGE_PAGE_TEXT,
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    const r2 = getResultJson(out.messages[3])
    const tabs = (r2?.observation as Record<string, unknown>)?.tabs as
      | Array<Record<string, unknown>>
      | undefined
    expect(Array.isArray(tabs?.[0]?.elements), 'newest observation kept full')
      .toBe(true)
    expect(
      (r2?.page_text as string).length,
      'newest read_page keeps its full page_text',
    ).toBeGreaterThan(1000)
  })
})

// ===========================================================================
// Group 4 — a BrowserScreenshot image shares the per-tab newest-to-oldest window: kept while its tab is the live
// snapshot, replaced with a placeholder text part once a newer observation supersedes it.
// ===========================================================================

const SCREENSHOT_IMAGE_STRIPPED_NOTE =
  'Screenshot image omitted to save tokens — re-run BrowserScreenshot if you need to see the page again.'

function canonicalScreenshotResult(
  toolCallId: string,
  tabId: number,
  imageBase64: string,
): Message {
  return {
    type: 'user',
    uuid: `u-${toolCallId}`,
    message: {
      role: 'user',
      content: [
        {
          type: PART_TOOL_RESULT_CANONICAL,
          toolCallId,
          result: [
            {
              type: PART_TEXT,
              text: JSON.stringify({
                action: 'screenshot',
                ok: true,
                observation: observationEnvelope([{ tab_id: tabId }]),
              }),
            },
            { type: PART_IMAGE, image: imageBase64, mimeType: 'image/jpeg' },
          ],
        },
      ],
    },
  } as Message
}

// Returns the `result` content-part array of a tool-result message.
function getResultParts(
  message: Message | undefined,
): Array<Record<string, unknown>> | null {
  const content = (message as { message?: { content?: unknown } } | undefined)
    ?.message?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === PART_TOOL_RESULT_CANONICAL &&
      Array.isArray((block as { result?: unknown }).result)
    ) {
      return (block as { result: Array<Record<string, unknown>> }).result
    }
  }
  return null
}

describe('multimodal screenshot follows observation window', () => {
  it('keeps the image when the screenshot is the newest observation', async () => {
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('a1', 'BrowserScreenshot'),
      canonicalScreenshotResult('a1', 5, 'BASE64IMAGEDATA'),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')
    const parts = getResultParts(out.messages[1])
    const image = parts?.find(p => p.type === PART_IMAGE)
    expect(image, 'newest screenshot keeps its image part').toBeTruthy()
    expect(image?.image).toBe('BASE64IMAGEDATA')
  })

  it('drops the image once a newer observation supersedes its tab', async () => {
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      // Older screenshot of tab 5.
      canonicalAssistantToolUse('a1', 'BrowserScreenshot'),
      canonicalScreenshotResult('a1', 5, 'BASE64IMAGEDATA'),
      // Newer observation for the SAME tab (a click) — supersedes it.
      canonicalAssistantToolUse('a2', 'BrowserClick'),
      canonicalToolResult('a2', {
        action: 'click',
        ok: true,
        observation: observationEnvelope([{ tab_id: 5 }]),
      }),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    // The older screenshot's image part is gone, replaced by a placeholder
    // text part; no PART_IMAGE remains in that result.
    const parts = getResultParts(out.messages[1])
    expect(parts?.some(p => p.type === PART_IMAGE), 'image dropped').toBe(false)
    expect(
      parts?.some(
        p =>
          p.type === PART_TEXT && p.text === SCREENSHOT_IMAGE_STRIPPED_NOTE,
      ),
      'image replaced with placeholder',
    ).toBe(true)
  })
})

// ===========================================================================
// Group — T0 observation-slimming interactions. A tab entry that carries no
// real `elements[]` array (basics-only from T0-b read_page/find_text, or a
// `{unchanged, count}` short-circuit stub from T0-c) must NOT occupy a
// keep-newest slot, otherwise it would push an older FULL snapshot of the
// same tab out to a placeholder even though it never carried the live
// snapshot. (Fix A / C3 in browserToolMicrocompact.)
// ===========================================================================

describe("T0 slimming — non-elements tabs do not occupy keep-newest slots", () => {
  function basicsOnlyResult(
    toolCallId: string,
    tabId: number,
  ): Message {
    // A read_page-style result: observation present with a basics-only tab
    // (tab_id/url/title, NO elements[]) plus a top-level page_text.
    return canonicalToolResult(toolCallId, {
      action: "read_page",
      page_text: "some page text",
      ok: true,
      observation: {
        tabs: [{ tab_id: tabId, url: "https://example.com/", title: "Home" }],
      },
    })
  }

  function unchangedStubResult(
    toolCallId: string,
    tabId: number,
    count: number,
  ): Message {
    return canonicalToolResult(toolCallId, {
      action: "click",
      ok: true,
      observation: {
        tabs: [
          {
            tab_id: tabId,
            url: "https://example.com/",
            title: "Home",
            elements: { unchanged: true, count },
          },
        ],
      },
    })
  }

  it("a basics-only read_page tab does not evict an older full snapshot", async () => {
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse("a1", "BrowserClick", { next_goal: "open" }),
      canonicalToolResult("a1", {
        action: "click",
        ok: true,
        observation: observationEnvelope([{ tab_id: 11 }]),
      }),
      canonicalAssistantToolUse("a2", "BrowserReadPage", { next_goal: "read" }),
      basicsOnlyResult("a2", 11),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, "sdk")

    // turn1 (full) is the newest FULL snapshot of tab 11 → kept.
    const r1 = getResultJson(out.messages[1])
    const t1 = (r1?.observation as { tabs?: Array<Record<string, unknown>> })
      ?.tabs?.[0]
    expect(Array.isArray(t1?.elements), "turn1 full elements kept").toBe(true)

    // turn2 basics-only stays basics-only (never carried elements).
    const r2 = getResultJson(out.messages[3])
    const t2 = (r2?.observation as { tabs?: Array<Record<string, unknown>> })
      ?.tabs?.[0]
    expect(t2?.elements, "turn2 has no elements").toBeUndefined()
    expect(t2?.tab_id, "turn2 tab_id preserved").toBe(11)
  })

  it("an {unchanged} stub passes through untouched and keeps the older full snapshot", async () => {
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse("a1", "BrowserClick", { next_goal: "open" }),
      canonicalToolResult("a1", {
        action: "click",
        ok: true,
        observation: observationEnvelope([{ tab_id: 11 }]),
      }),
      canonicalAssistantToolUse("a2", "BrowserClick", { next_goal: "reclick" }),
      unchangedStubResult("a2", 11, 3),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, "sdk")

    const r1 = getResultJson(out.messages[1])
    const t1 = (r1?.observation as { tabs?: Array<Record<string, unknown>> })
      ?.tabs?.[0]
    expect(Array.isArray(t1?.elements), "turn1 full elements kept").toBe(true)

    const r2 = getResultJson(out.messages[3])
    const t2 = (r2?.observation as { tabs?: Array<Record<string, unknown>> })
      ?.tabs?.[0]
    expect(
      (t2?.elements as { unchanged?: boolean })?.unchanged,
      "stub passes through unchanged",
    ).toBe(true)
    expect((t2?.elements as { count?: number })?.count, "stub count kept").toBe(3)
  })
})

// ===========================================================================
// Group 5 — tool-agnostic media budget (non-Browser tools). Newest-to-oldest with one shared budget: the newest
// media part is always kept; every later one is subject to the count cap (2) and the char budget (128,000).
// ===========================================================================

const STALE_TOOL_MEDIA_STRIPPED_NOTE =
  'Image omitted to save tokens — a more recent turn carries the images that are still live; re-read the file if you need to see this one again.'

// A hosted `Read` result in content-part shape:
// [{type:text, text:'Image file read: …'}, {type:image, image:<base64>}].
function canonicalReadImageResult(
  toolCallId: string,
  imageBase64: string,
): Message {
  return {
    type: 'user',
    uuid: `u-${toolCallId}`,
    message: {
      role: 'user',
      content: [
        {
          type: PART_TOOL_RESULT_CANONICAL,
          toolCallId,
          result: [
            { type: PART_TEXT, text: `Image file read: /tmp/${toolCallId}.png` },
            { type: PART_IMAGE, image: imageBase64, mimeType: 'image/jpeg' },
          ],
        },
      ],
    },
  } as Message
}

describe('non-Browser tool media budget', () => {
  it('keeps the newest Read image however large it is', async () => {
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('r1', 'Read'),
      // Bigger than MAX_LIVE_TOOL_MEDIA_CHARS (4_000_000) on its own — still
      // kept, or the tool the model just called would return nothing it can
      // look at. (A 200k payload here pinned nothing once the cap was raised.)
      canonicalReadImageResult('r1', 'A'.repeat(5_000_000)),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')
    const parts = getResultParts(out.messages[1])
    const image = parts?.find(p => p.type === PART_IMAGE)
    expect(image, 'newest Read image survives').toBeTruthy()
    expect((image?.image as string)?.length).toBe(5_000_000)
  })

  it('strips an older Read image once newer ones are live', async () => {
    // THE regression. Without the media budget every image a session ever read
    // stays on the wire for the rest of it.
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('r1', 'Read'),
      canonicalReadImageResult('r1', 'A'.repeat(200_000)),
      canonicalAssistantToolUse('r2', 'Read'),
      canonicalReadImageResult('r2', 'B'.repeat(200_000)),
      canonicalAssistantToolUse('r3', 'Read'),
      canonicalReadImageResult('r3', 'C'.repeat(200_000)),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    // Newest (r3) keeps its image.
    const newest = getResultParts(out.messages[5])
    expect(
      newest?.some(p => p.type === PART_IMAGE),
      'newest Read keeps its image',
    ).toBe(true)

    // Oldest (r1) falls off the back of the part cap → placeholder.
    const oldest = getResultParts(out.messages[1])
    expect(
      oldest?.some(p => p.type === PART_IMAGE),
      'older Read image dropped',
    ).toBe(false)
    expect(
      oldest?.some(
        p => p.type === PART_TEXT && p.text === STALE_TOOL_MEDIA_STRIPPED_NOTE,
      ),
      'older Read image replaced with placeholder',
    ).toBe(true)
    // The result's own text part is untouched — only media is budgeted.
    expect(
      oldest?.some(
        p => p.type === PART_TEXT && p.text === 'Image file read: /tmp/r1.png',
      ),
      'text part preserved',
    ).toBe(true)
  })

  it('keeps a second small image that fits the char budget', async () => {
    // Guards against the budget being so aggressive it strips everything but
    // the newest: two small images fit both the count cap and the chars.
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('r1', 'Read'),
      canonicalReadImageResult('r1', 'A'.repeat(1_000)),
      canonicalAssistantToolUse('r2', 'Read'),
      canonicalReadImageResult('r2', 'B'.repeat(1_000)),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')
    expect(
      getResultParts(out.messages[1])?.some(p => p.type === PART_IMAGE),
      'second-newest small image kept',
    ).toBe(true)
    expect(
      getResultParts(out.messages[3])?.some(p => p.type === PART_IMAGE),
      'newest small image kept',
    ).toBe(true)
  })

  it('drops a third small image at the count cap', async () => {
    // Pins MAX_LIVE_TOOL_MEDIA_PARTS = 2: small enough to pass the char
    // budget, so only the count cap can be what strips the oldest.
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('r1', 'Read'),
      canonicalReadImageResult('r1', 'A'.repeat(1_000)),
      canonicalAssistantToolUse('r2', 'Read'),
      canonicalReadImageResult('r2', 'B'.repeat(1_000)),
      canonicalAssistantToolUse('r3', 'Read'),
      canonicalReadImageResult('r3', 'C'.repeat(1_000)),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')
    expect(
      getResultParts(out.messages[1])?.some(p => p.type === PART_IMAGE),
      'oldest image dropped at the count cap',
    ).toBe(false)
    expect(
      getResultParts(out.messages[3])?.some(p => p.type === PART_IMAGE),
      'second-newest kept',
    ).toBe(true)
    expect(
      getResultParts(out.messages[5])?.some(p => p.type === PART_IMAGE),
      'newest kept',
    ).toBe(true)
  })

  it('keeps every image of the newest message — parallel Reads merged into one message', async () => {
    // Three parallel Reads land as three tool results in ONE user message.
    // The model asked for all three; the count cap must not strip the third
    // before it is ever seen (the walk used to run oldest-to-newest inside
    // the message). An older image still ages out under the cap.
    const microcompact = createBrowserToolMicrocompact()
    const merged = canonicalReadImageResult('p1', 'P'.repeat(1_000))
    const content = (merged as unknown as { message: { content: unknown[] } }).message.content
    for (const id of ['p2', 'p3']) {
      content.push(
        ...(canonicalReadImageResult(id, 'Q'.repeat(1_000)) as unknown as { message: { content: unknown[] } })
          .message.content,
      )
    }
    const messages: Message[] = [
      canonicalAssistantToolUse('old', 'Read'),
      canonicalReadImageResult('old', 'O'.repeat(1_000)),
      {
        type: 'assistant',
        uuid: 'a-par',
        message: {
          role: 'assistant',
          content: ['p1', 'p2', 'p3'].map(id => ({
            type: PART_TOOL_CALL,
            toolCallId: id,
            toolName: 'Read',
            args: {},
          })),
        },
      } as Message,
      merged,
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')
    const blocks = (out.messages[3] as unknown as { message: { content: Array<{ result: Array<{ type: string }> }> } })
      .message.content
    expect(blocks.map(b => b.result.some(p => p.type === PART_IMAGE))).toEqual([true, true, true])
    expect(
      getResultParts(out.messages[1])?.some(p => p.type === PART_IMAGE),
      'older image beyond the cap dropped',
    ).toBe(false)
  })

  it('is idempotent — a second pass changes nothing', async () => {
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('r1', 'Read'),
      canonicalReadImageResult('r1', 'A'.repeat(200_000)),
      canonicalAssistantToolUse('r2', 'Read'),
      canonicalReadImageResult('r2', 'B'.repeat(200_000)),
      followUpUser(),
    ]
    const once = await microcompact(messages, STUB_CTX, 'sdk')
    const twice = await microcompact(once.messages, STUB_CTX, 'sdk')
    expect(getResultParts(twice.messages[1])).toEqual(
      getResultParts(once.messages[1]),
    )
    expect(getResultParts(twice.messages[3])).toEqual(
      getResultParts(once.messages[3]),
    )
  })

  it('charges a live BrowserScreenshot image against the same media budget', async () => {
    // The Browser* path decides an image's fate on tab liveness, not on this
    // budget — but an image it keeps is just as live on the wire. Leaving it
    // uncharged let the cap leak: a live screenshot plus two Read images put
    // THREE media payloads on a wire whose declared cap is two.
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('r1', 'Read'),
      canonicalReadImageResult('r1', 'A'.repeat(1_000)),
      canonicalAssistantToolUse('r2', 'Read'),
      canonicalReadImageResult('r2', 'B'.repeat(1_000)),
      // Newest, and its tab is the live snapshot, so pass (0) keeps its image.
      canonicalAssistantToolUse('s1', 'BrowserScreenshot'),
      canonicalScreenshotResult('s1', 5, 'C'.repeat(1_000)),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    const live = [1, 3, 5].filter(i =>
      getResultParts(out.messages[i])?.some(p => p.type === PART_IMAGE),
    )
    expect(live.length, 'live media parts stay within the declared cap').toBe(2)
    expect(live, 'the screenshot and the newest Read survive').toEqual([3, 5])
  })

  it('strips a second image that blows the char budget on its own', async () => {
    // The part cap is the effective limit in practice — media is billed
    // natively (~1.6k tokens), so MAX_LIVE_TOOL_MEDIA_CHARS sits far above two
    // real screenshots and only catches a pathological payload. This is that
    // payload: the newest is always kept, the one behind it does not fit.
    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('r1', 'Read'),
      canonicalReadImageResult('r1', 'A'.repeat(5_000_000)),
      canonicalAssistantToolUse('r2', 'Read'),
      canonicalReadImageResult('r2', 'B'.repeat(1_000)),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')
    expect(
      getResultParts(out.messages[3])?.some(p => p.type === PART_IMAGE),
      'newest kept',
    ).toBe(true)
    expect(
      getResultParts(out.messages[1])?.some(p => p.type === PART_IMAGE),
      'oversized older image stripped by the char budget',
    ).toBe(false)
  })

  it('ages out media in a legacy content-shaped tool result too', async () => {
    // The legacy `content`-shaped envelope carries media exactly as the
    // canonical `result`-shaped one does. Reading only `result` returned early,
    // so its images rode every request for the rest of the session — the
    // precise bug this pass exists to fix, on the other envelope shape.
    const legacyReadImageResult = (
      toolCallId: string,
      imageBase64: string,
    ): Message =>
      ({
        type: 'user',
        uuid: `u-${toolCallId}`,
        message: {
          role: 'user',
          content: [
            {
              type: PART_TOOL_RESULT_CANONICAL,
              toolCallId,
              content: [
                { type: PART_TEXT, text: `Image file read: /tmp/${toolCallId}.png` },
                { type: PART_IMAGE, image: imageBase64, mimeType: 'image/jpeg' },
              ],
            },
          ],
        },
      }) as Message
    const legacyParts = (
      message: Message | undefined,
    ): Array<Record<string, unknown>> | null => {
      const content = (message as { message?: { content?: unknown } } | undefined)
        ?.message?.content
      if (!Array.isArray(content)) return null
      const block = content[0] as { content?: unknown }
      return Array.isArray(block?.content)
        ? (block.content as Array<Record<string, unknown>>)
        : null
    }

    const microcompact = createBrowserToolMicrocompact()
    const messages: Message[] = [
      canonicalAssistantToolUse('r1', 'Read'),
      legacyReadImageResult('r1', 'A'.repeat(200_000)),
      canonicalAssistantToolUse('r2', 'Read'),
      legacyReadImageResult('r2', 'B'.repeat(200_000)),
      canonicalAssistantToolUse('r3', 'Read'),
      legacyReadImageResult('r3', 'C'.repeat(200_000)),
      followUpUser(),
    ]
    const out = await microcompact(messages, STUB_CTX, 'sdk')

    expect(
      legacyParts(out.messages[5])?.some(p => p.type === PART_IMAGE),
      'newest legacy-shaped image kept',
    ).toBe(true)
    expect(
      legacyParts(out.messages[1])?.some(p => p.type === PART_IMAGE),
      'older legacy-shaped image aged out',
    ).toBe(false)
    expect(
      legacyParts(out.messages[1])?.some(
        p => p.type === PART_TEXT && p.text === STALE_TOOL_MEDIA_STRIPPED_NOTE,
      ),
      'replaced by the strip note, in the same content field',
    ).toBe(true)
  })
})
