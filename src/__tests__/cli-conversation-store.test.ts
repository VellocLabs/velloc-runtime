/**
 * A CLI session's conversation id in its metadata (F-34): through the bound
 * store, a disk-only patch of an existing `meta.json`, or a new `meta.json`
 * for a session that never persisted — so the session is listed.
 */
import { describe, expect, it } from 'vitest'
import type { BrowserSessionMetadata, SessionMetaFile } from '../sessions/sessionStore'
import {
  createCliConversationStore,
  type CliConversationEntry,
  type CliConversationStoreDeps,
} from '../browser/worker/cliConversationStore'

const CONVERSATION = '0b7f3c2e-9a41-4d6b-8f0e-5c2d1a3b4e6f'

function rig(options: { meta?: Record<string, SessionMetaFile>; entry?: CliConversationEntry; storage?: boolean } = {}) {
  const meta: Record<string, SessionMetaFile> = { ...options.meta }
  const calls: string[] = []
  const created: Array<Parameters<CliConversationStoreDeps['writeNewSession']>[0]> = []
  const store = createCliConversationStore({
    storage: () =>
      options.storage === false
        ? null
        : {
            readSessionMeta: async id => meta[id] ?? null,
            writeSessionMeta: async (id, next) => {
              calls.push(`write ${id}`)
              meta[id] = next
            },
          },
    entry: () => options.entry,
    ensureRouting: async () => {
      calls.push('route')
    },
    refreshSummary: async id => {
      calls.push(`summary ${id}`)
    },
    writeNewSession: async args => {
      calls.push(`new ${args.sessionId}`)
      created.push(args)
    },
    now: () => 42,
  })
  return { store, meta, calls, created }
}

const existing = (metadata: BrowserSessionMetadata): SessionMetaFile => ({
  schemaVersion: 1,
  sessionId: 's1',
  updatedAt: 1,
  customTitle: 'Mine',
  metadata,
})

describe('CLI conversation store', () => {
  it('a session that never persisted gets a new meta.json with its type, folder and conversation', async () => {
    const r = rig({ entry: { templateType: 'cli-codex', projectRoot: 'D:/work/api' } })
    await r.store.record('s1', { cli: 'claude', id: CONVERSATION })
    expect(r.calls).toEqual(['route', 'new s1'])
    expect(r.created).toEqual([
      {
        sessionId: 's1',
        meta: {
          schemaVersion: 1,
          sessionId: 's1',
          updatedAt: 42,
          metadata: {
            templateType: 'cli-codex',
            projectRoot: 'D:/work/api',
            createdAt: 42,
            cliConversation: { cli: 'claude', id: CONVERSATION },
          },
        },
        projectRoot: 'D:/work/api',
        templateType: 'cli-codex',
      },
    ])
  })

  it('an existing meta.json is patched in place, keeping its other fields, and the row refreshed', async () => {
    const r = rig({ meta: { s1: existing({ templateType: 'cli-codex', pinned: true }) } })
    await r.store.record('s1', { cli: 'codex', id: null })
    expect(r.calls).toEqual(['route', 'write s1', 'summary s1'])
    expect(r.meta.s1).toMatchObject({
      customTitle: 'Mine',
      metadata: { templateType: 'cli-codex', pinned: true, cliConversation: { cli: 'codex', id: null } },
    })
    expect(await r.store.read('s1')).toEqual({ cli: 'codex', id: null })
  })

  it('a bound session writes and reads through its store, not the disk', async () => {
    let metadata: BrowserSessionMetadata = {}
    const r = rig({
      entry: {
        conversationStore: {
          getSessionMetadata: async () => metadata,
          updateSessionMetadata: async patch => {
            metadata = { ...metadata, ...patch }
          },
          storeAutoTitle: async () => {},
        },
      },
    })
    await r.store.record('s1', { cli: 'claude', id: CONVERSATION })
    expect(r.calls).toEqual([])
    expect(await r.store.read('s1')).toEqual({ cli: 'claude', id: CONVERSATION })
  })

  it('a store that binds while the record is written to disk gets the record too', async () => {
    let metadata: BrowserSessionMetadata = {}
    const entry: CliConversationEntry = { templateType: 'cli-codex', projectRoot: 'D:/work/api' }
    const r = rig({ entry })
    const bindDuringWrite = {
      getSessionMetadata: async () => metadata,
      updateSessionMetadata: async (patch: Partial<BrowserSessionMetadata>) => {
        metadata = { ...metadata, ...patch }
      },
      storeAutoTitle: async () => {},
    }
    const pending = r.store.record('s1', { cli: 'codex', id: CONVERSATION })
    entry.conversationStore = bindDuringWrite
    await pending
    expect(r.calls).toEqual(['route', 'new s1'])
    expect(metadata.cliConversation).toEqual({ cli: 'codex', id: CONVERSATION })
  })

  it('reads nothing for a missing or malformed record, and refuses to record without storage', async () => {
    const r = rig({ meta: { s1: existing({ cliConversation: { cli: 'codex', id: '--resume x' } }) } })
    expect(await r.store.read('s1')).toBeUndefined()
    expect(await r.store.read('s2')).toBeUndefined()
    const none = rig({ storage: false })
    await expect(none.store.record('s1', { cli: 'codex', id: CONVERSATION })).rejects.toThrow()
  })

  it('retitle sets the automatic title of a stored session, leaves a manual one in charge, and refreshes the row', async () => {
    const r = rig({ meta: { s1: existing({ templateType: 'cli-codex' }) } })
    await r.store.retitle?.('s1', 'Fix the login form')
    expect(r.calls).toEqual(['route', 'write s1', 'summary s1'])
    expect(r.meta.s1).toMatchObject({ updatedAt: 42, customTitle: 'Mine', aiTitle: 'Fix the login form' })
  })

  it('retitle writes nothing for a session with no meta.json, and goes through a bound store', async () => {
    const r = rig()
    await r.store.retitle?.('s1', 'Anything')
    expect(r.calls).toEqual(['route'])
    const titles: string[] = []
    const bound = rig({
      entry: {
        conversationStore: {
          getSessionMetadata: async () => ({}),
          updateSessionMetadata: async () => {},
          storeAutoTitle: async title => {
            titles.push(title)
          },
        },
      },
    })
    await bound.store.retitle?.('s1', 'Review the diff')
    expect(titles).toEqual(['Review the diff'])
    expect(bound.calls).toEqual(['summary s1'])
  })
})
