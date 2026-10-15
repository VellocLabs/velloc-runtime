import { describe, expect, it } from 'vitest'
import {
  collectSkillDiscoveryAttachments,
  collectSkillListingAttachments,
} from '../messages/contextAttachments'
import {
  BrowserConversationStore,
  type BrowserConversationStorageBackend,
  type BrowserTranscriptEntry,
  type BrowserTranscriptWriteEntry,
  type SessionMetaFile,
} from '../sessions/sessionStore'
import type { Message } from '../runtime/RuntimeTypes'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'

// Both skill reminders that advertise an activatable skill (the discovery reminder and the skill listing)
// exclude a skill already active this session: appState.activeSkills union the skills derived from the live
// transcript, which is what survives a resume.

const a2uiCommand = {
  type: 'prompt',
  name: 'a2ui',
  description: 'render a counter surface',
  path: '/hosted/a2ui',
  // a2ui is a hosted skill — `hostedSkillToCommand` stamps these, and the
  // model-surface gate (getModelInvocableCommands) keys off `loadedFrom`.
  loadedFrom: 'bundled',
  source: 'bundled',
}

// The a2ui_* command tools, carrying skill:'a2ui' (used by the tool→skill
// resolver so a ToolSearch activation can be mapped back to its skill).
const a2uiTools = [
  { name: 'a2ui_create_surface', skill: 'a2ui' },
  { name: 'a2ui_update_data_model', skill: 'a2ui' },
]

// A persisted assistant Skill('a2ui') tool-call, as it appears in the hydrated
// transcript (same shape the surface store + deriveActivatedSkillsFromMessages
// read).
const a2uiSkillCall = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool-call', toolName: 'Skill', args: { skill: 'a2ui' } }],
  },
}

// How a REAL model (gpt-5.5) activates a2ui — via ToolSearch select:, NOT Skill.
// The transcript records the tool name; the resolver maps it back to 'a2ui'.
const a2uiToolSearchCall = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolName: 'ToolSearch',
        args: { query: 'select:a2ui_create_surface', max_results: 1 },
      },
    ],
  },
}

// A persisted `skill_listing` attachment as it appears in the HYDRATED
// transcript: an ATTACHMENT-typed message carrying the structured payload —
// NOT a user message with rendered text (the listing text is produced only by
// renderSkillListingAttachment at request-assembly time, so `message.content`
// does not exist here). This is the exact shape the resume de-dup must recover
// "already advertised" from. `skillNames` is the authoritative list.
const a2uiListingAttachment = {
  type: 'attachment',
  attachment: {
    type: 'skill_listing',
    content: '- a2ui: render a counter surface',
    skillCount: 1,
    isInitial: true,
    skillNames: ['a2ui'],
  },
}

// Same, but persisted BEFORE the `skillNames` field existed — the de-dup must
// fall back to parsing the rendered `content` entries (`- <name>: …`).
const a2uiListingAttachmentLegacy = {
  type: 'attachment',
  attachment: {
    type: 'skill_listing',
    content: '- a2ui: render a counter surface',
    skillCount: 1,
    isInitial: true,
  },
}

// A persisted `skill_discovery` attachment — carries its `skills[]` directly.
const a2uiDiscoveryAttachment = {
  type: 'attachment',
  attachment: {
    type: 'skill_discovery',
    skills: [{ name: 'a2ui', description: 'render a counter surface' }],
    signal: 'user_input',
    source: 'native',
  },
}

function makeContext(
  activeSkills: string[],
  messages: unknown[] = [],
  // Skill-tool presence gate: the listing /
  // discovery reminders are suppressed for agents whose tool set excludes the
  // Skill tool. Production sessions carry it, so default to including it; pass
  // `false` to model a Skill-less sub-agent.
  withSkillTool = true,
) {
  let appState: Record<string, unknown> = {
    activeSkills,
    attachmentState: {},
  }
  const tools = withSkillTool ? [...a2uiTools, { name: 'Skill' }] : a2uiTools
  return {
    options: { commands: [a2uiCommand], tools },
    messages,
    readAppState: () => appState,
    writeAppState: (updater: (prev: typeof appState) => typeof appState) => {
      appState = updater(appState)
    },
    skillsFound: new Set<string>(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('skill reminders — suppressed when the Skill tool is absent', () => {
  // An agent whose tool
  // set excludes the Skill tool (e.g. a sub-agent with a minimal `tools:`
  // allowlist, or a forked-skill scope) cannot invoke skills, so neither the
  // listing nor the discovery reminder should fire — otherwise the model is
  // told to "invoke the Skill tool" it does not have, wasting/failing the turn.
  it('listing returns [] when options.tools has no Skill tool', () => {
    // Same context that lists a2ui WITH the Skill tool (below), minus Skill.
    expect(collectSkillListingAttachments(makeContext([], [], false))).toEqual(
      [],
    )
  })

  it('discovery returns [] when options.tools has no Skill tool', () => {
    expect(
      collectSkillDiscoveryAttachments(
        'counter surface',
        makeContext([], [], false),
      ),
    ).toEqual([])
  })
})

describe('collectSkillDiscoveryAttachments — active-skill exclusion', () => {
  it('discovers a relevant skill that is NOT active', () => {
    const out = collectSkillDiscoveryAttachments('counter surface', makeContext([]))
    expect(out).toHaveLength(1)
    expect(out[0].skills.map(s => s.name)).toEqual(['a2ui'])
  })

  it('does NOT re-suggest a skill that is already active (via appState)', () => {
    const out = collectSkillDiscoveryAttachments(
      'counter surface',
      makeContext(['a2ui']),
    )
    expect(out).toEqual([])
  })
})

describe('collectSkillListingAttachments — active-skill exclusion', () => {
  it('lists a skill that is NOT active', () => {
    const out = collectSkillListingAttachments(makeContext([]))
    expect(out).toHaveLength(1)
    expect(out[0].content).toContain('a2ui')
  })

  it('does NOT re-advertise a skill that is already active (via appState)', () => {
    // The listing-side twin of the discovery guard. On resume `sentSkillNames`
    // is empty, so a2ui would be "unsent" and re-listed — but it is active, so
    // it must be filtered out, leaving nothing to list.
    const out = collectSkillListingAttachments(makeContext(['a2ui']))
    expect(out).toEqual([])
  })
})

describe('skill reminders — active via the transcript with EMPTY appState (resume)', () => {
  // The exact reload bug: after a relaunch appState.activeSkills is empty (the
  // createBrowserRuntime seed ran with a stale/empty message snapshot), but the
  // hydrated transcript shows a prior Skill('a2ui') activation. Both reminders
  // MUST still exclude a2ui — otherwise the model re-invokes Skill('a2ui') on
  // the next click. This is the unit-level analogue of the relaunch e2e.
  it('discovery excludes a transcript-active skill even when appState is empty', () => {
    const ctx = makeContext([], [a2uiSkillCall])
    expect(collectSkillDiscoveryAttachments('counter surface', ctx)).toEqual([])
  })

  it('listing excludes a transcript-active skill even when appState is empty', () => {
    const ctx = makeContext([], [a2uiSkillCall])
    expect(collectSkillListingAttachments(ctx)).toEqual([])
  })
})

describe('skill reminders — active via a ToolSearch select: with EMPTY appState (resume)', () => {
  // The actual reported scenario: gpt-5.5 activates a2ui via
  // `ToolSearch select:a2ui_create_surface` (NOT Skill). After a reload appState
  // is empty, so the active set must be re-derived from that ToolSearch call —
  // mapping the loaded tool name → skill 'a2ui' via the resolver — or both
  // reminders re-advertise a2ui and the model re-runs ToolSearch on every click.
  it('discovery excludes a skill activated via ToolSearch even when appState is empty', () => {
    const ctx = makeContext([], [a2uiToolSearchCall])
    expect(collectSkillDiscoveryAttachments('counter surface', ctx)).toEqual([])
  })

  it('listing excludes a skill activated via ToolSearch even when appState is empty', () => {
    const ctx = makeContext([], [a2uiToolSearchCall])
    expect(collectSkillListingAttachments(ctx)).toEqual([])
  })
})

describe('skill reminders — ADVERTISED/DISCOVERED via the transcript with EMPTY appState (resume)', () => {
  // After a resume, "already advertised" is recovered from the recorded skill_listing attachment message (a
  // structured payload, no `message.content`).
  it('listing does NOT re-advertise a skill already listed in the transcript (skillNames)', () => {
    const ctx = makeContext([], [a2uiListingAttachment])
    expect(collectSkillListingAttachments(ctx)).toEqual([])
  })

  it('listing falls back to parsing content for a legacy listing without skillNames', () => {
    const ctx = makeContext([], [a2uiListingAttachmentLegacy])
    expect(collectSkillListingAttachments(ctx)).toEqual([])
  })

  // The discovery-side twin of the same bug: after a reload `discoveredSkillNames`
  // is empty, so a previously-suggested (never-activated) skill is re-suggested
  // whenever the input re-matches. Recovered from the skill_discovery attachment.
  it('discovery does NOT re-suggest a skill already discovered in the transcript', () => {
    const ctx = makeContext([], [a2uiDiscoveryAttachment])
    expect(collectSkillDiscoveryAttachments('counter surface', ctx)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// REAL persist→hydrate→recover round-trip (in-process analogue of the
// nexus-tools-defer "NOT re-advertised after a resume" e2e). The cases above
// hand-build the attachment in `context.messages`; this drives the ACTUAL
// BrowserConversationStore.saveTranscriptRows + hydrateMessagesForModel path so
// the recovery runs against the SAME message shape the engine sees on resume —
// catching any shape drift the hand-built fixtures miss.
// ---------------------------------------------------------------------------

class MemBackend implements BrowserConversationStorageBackend {
  readonly entries = new Map<string, BrowserTranscriptEntry[]>()
  readonly metas = new Map<string, SessionMetaFile>()
  async append(sessionId: string, entry: BrowserTranscriptWriteEntry): Promise<void> {
    const arr = this.entries.get(sessionId) ?? []
    arr.push(JSON.parse(JSON.stringify(entry)))
    this.entries.set(sessionId, arr)
  }
  async load(sessionId: string) {
    const arr = this.entries.get(sessionId)
    return arr ? (JSON.parse(JSON.stringify(arr)) as BrowserTranscriptEntry[]) : null
  }
  async readSessionMeta(sessionId: string) {
    return this.metas.get(sessionId) ?? null
  }
  async writeSessionMeta(sessionId: string, meta: SessionMetaFile) {
    this.metas.set(sessionId, JSON.parse(JSON.stringify(meta)))
  }
  async flush(): Promise<void> {}
}

function makeRuntimeConfig(): RuntimeConfig {
  let uuid = 0
  return {
    createUUID: () => `uuid-${uuid++}`,
    createTimestamp: () => '2026-01-01T00:00:00.000Z',
    now: () => 1000,
  } as unknown as RuntimeConfig
}

describe('skill LISTING — REAL persist→hydrate→recover round-trip (resume)', () => {
  // Turn 1, persisted exactly as the runtime records it: a user prompt, the
  // skill_listing ATTACHMENT (makeContextRow shape — top-level
  // `attachment`, no `message.content`), then the assistant reply.
  const turn1: Message[] = [
    {
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    } as unknown as Message,
    {
      type: 'attachment',
      uuid: 'att1',
      timestamp: '2026-01-01T00:00:00.000Z',
      attachment: {
        type: 'skill_listing',
        content: '- a2ui: render a counter surface',
        skillCount: 1,
        isInitial: true,
        skillNames: ['a2ui'],
      },
    } as unknown as Message,
    {
      type: 'assistant',
      uuid: 'a1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    } as unknown as Message,
  ]

  it('does NOT re-advertise a2ui after a RESUME (second store instance loads from disk)', async () => {
    const backend = new MemBackend()
    const sessionId = 'sess-resume-listing'
    // Instance #1 records turn 1.
    const store1 = new BrowserConversationStore({
      runtimeConfig: makeRuntimeConfig(),
      sessionId,
      storageBackend: backend,
    })
    await store1.saveTranscriptRows(turn1)

    // RESUME: a FRESH store instance over the SAME backend (mirrors browser
    // instance #2 loading the session from disk). This exercises the real
    // resume path — ensureLoaded → normalizeConversationState →
    // recordedMessages = activeMessages (the leaf-chain), NOT the full
    // transcript (sessionStorage.ts ensureLoaded). The single-instance variant
    // masked the bug by returning the full appended list.
    const store2 = new BrowserConversationStore({
      runtimeConfig: makeRuntimeConfig(),
      sessionId,
      storageBackend: backend,
    })
    const hydrated = await store2.hydrateMessagesForModel()
    const ctx = makeContext([], hydrated as unknown[])
    expect(collectSkillListingAttachments(ctx)).toEqual([])
  })
})
