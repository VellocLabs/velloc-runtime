import { describe, expect, it } from 'vitest'
import { projectSessionInfo } from '../browser/worker/sessionInfoProjection'
import { mergeSessions, type LocalSessionEntry } from '../browser/webview/useSessionManager'
import { buildSessionSummaryFromMeta, SESSION_META_FILE_SCHEMA_VERSION, type SessionMetaFile } from '../sessions/sessionStore'

// Whether a session's title is a manual rename travels as its own flag (F-34):
// the summary's `customTitle` also carries an automatic title, so only
// `renamed` tells the two apart, and **Use automatic title** reads it.

const meta = (fields: Partial<SessionMetaFile>): SessionMetaFile => ({
  schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
  sessionId: 's',
  updatedAt: 1_000,
  metadata: { templateType: 'cli-codex' },
  ...fields,
})

describe('the renamed flag', () => {
  it('a persisted rename is one; an automatic title is not', () => {
    expect(buildSessionSummaryFromMeta(meta({ customTitle: 'Mine', aiTitle: 'Auto' }))).toMatchObject({
      customTitle: 'Mine',
      renamed: true,
    })
    const auto = buildSessionSummaryFromMeta(meta({ aiTitle: 'Auto' }))!
    expect(auto.customTitle).toBe('Auto')
    expect(auto.renamed).toBe(false)
    expect(buildSessionSummaryFromMeta(meta({}))?.renamed).toBeUndefined()
  })

  it('the card follows a live rename and its clear ahead of the summary, and a clear shows the automatic title', () => {
    const renamedOnDisk = buildSessionSummaryFromMeta(meta({ customTitle: 'Mine', aiTitle: 'Auto' }))!
    const autoOnDisk = buildSessionSummaryFromMeta(meta({ aiTitle: 'Auto' }))!
    const card = (live: { customTitle?: string | null } | undefined, fs = autoOnDisk) =>
      projectSessionInfo({ sessionId: 's', entry: undefined, live, fs })
    expect(card(undefined)).toMatchObject({ title: 'Auto' })
    expect(card(undefined)?.renamed).toBeUndefined()
    expect(card({ customTitle: 'Mine' })).toMatchObject({ title: 'Mine', renamed: true })
    // Cleared, with the summary refreshed: the automatic title, not a rename.
    expect(card({ customTitle: null })).toMatchObject({ title: 'Auto' })
    expect(card({ customTitle: null })?.renamed).toBeUndefined()
    // Cleared, before the refresh lands: the old rename is not shown.
    expect(card({ customTitle: null }, renamedOnDisk)?.title).not.toBe('Mine')
    // A summary that does not say its title is automatic keeps the clear.
    const { renamed: _unknown, ...unmarked } = renamedOnDisk
    expect(card({ customTitle: null }, unmarked)?.title).not.toBe('Mine')
  })

  it('the client keeps its own rename until the runtime agrees, and takes the runtime’s word otherwise', () => {
    const local = (fields: Partial<LocalSessionEntry>): Map<string, LocalSessionEntry> =>
      new Map([['s', { sessionId: 's', title: 'Mine', previewText: '', updatedAt: 2_000, messageCount: 0, composerDraft: '', lastComposerEditAt: 0, ...fields }]])
    const renamedOf = (remote: { renamed?: boolean; updatedAt: number }, cache: Map<string, LocalSessionEntry>) =>
      mergeSessions([{ sessionId: 's', title: 'Auto', customTitle: 'Auto', ...remote }], cache)[0]!.renamed === true
    expect(renamedOf({ updatedAt: 1_000 }, new Map())).toBe(false)
    expect(renamedOf({ updatedAt: 1_000, renamed: true }, new Map())).toBe(true)
    // Renamed here (fresher than the summary): renamed before the runtime says so.
    expect(renamedOf({ updatedAt: 1_000 }, local({ renamed: true }))).toBe(true)
    // An older local rename does not outlive the runtime's newer summary.
    expect(renamedOf({ updatedAt: 3_000 }, local({ renamed: true }))).toBe(false)
  })
})
