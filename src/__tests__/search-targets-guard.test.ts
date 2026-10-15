import { describe, expect, it } from 'vitest'

import type { ScopeMode } from '../browser/runtimeProtocol'
import {
  searchTargetsGuard,
  transcriptTargetSessionId,
} from '../browser/runtimeHub/searchTargetsGuard'
import type { ConnectionInfo, RuntimeContext } from '../browser/runtimeHub/types'
import { transcriptPathForSession } from '../browser/webview/searchTargets'
import { projectsHome } from '../utils/conversationStoragePaths'

/**
 * `search.queryTranscripts` moved from `full` to `control` (a
 * remote page's topbar search searches the HOST's conversations). Its payload
 * is absolute paths the host walks as given, so below `full` the runtime
 * admits only session transcripts under the projects root — and only the
 * sessions a limited grant names. Without the guard a control remote could
 * text-search any file on the host (`C:/Users/u/.ssh/id_rsa`, …).
 */

const HOME = 'C:/Users/u'
const ROOT = projectsHome(HOME)

function conn(mode: ScopeMode, sessions: 'all' | string[] = 'all'): ConnectionInfo {
  return {
    connectionId: 'c',
    clientId: 'c',
    kind: 'remote',
    scope: { mode, sessions },
    transport: 'websocket',
  } as unknown as ConnectionInfo
}

function ctx(homeDir = HOME): RuntimeContext {
  return { homeDir } as unknown as RuntimeContext
}

/** The path the client builds for a session — the one shape the guard admits. */
function target(sessionId: string, projectRoot = 'D:/work/app'): string {
  return transcriptPathForSession(HOME, { sessionId, title: '', updatedAt: 0, projectRoot })
}

describe('transcriptTargetSessionId', () => {
  it('reads the session id from the path the client builds', () => {
    expect(transcriptTargetSessionId(target('s-1'), ROOT)).toBe('s-1')
  })

  it('accepts either separator (a Windows host)', () => {
    expect(transcriptTargetSessionId(target('s-1').replace(/\//g, '\\'), ROOT)).toBe('s-1')
  })

  it.each([
    ['a file outside the projects root', `${HOME}/.ssh/id_rsa`],
    ['a sibling of the root with the same prefix', `${ROOT}-evil/p/s/transcript.jsonl`],
    ['another file in a session dir', `${ROOT}/p/s/meta.json`],
    ['a traversal segment', `${ROOT}/p/../../../.ssh/transcript.jsonl`],
    ['a dot session segment', `${ROOT}/p/./transcript.jsonl`],
    ['too shallow', `${ROOT}/p/transcript.jsonl`],
    ['too deep', `${ROOT}/p/s/sub/transcript.jsonl`],
    ['an empty segment', `${ROOT}/p//transcript.jsonl`],
  ])('rejects %s', (_label, path) => {
    expect(transcriptTargetSessionId(path, ROOT)).toBeUndefined()
  })
})

describe('searchTargetsGuard', () => {
  it.each(['control', 'manager'] as const)('admits transcript targets for a %s grant', async mode => {
    expect(
      await searchTargetsGuard({ targets: [target('a'), target('b', 'E:/x')] }, conn(mode), ctx()),
    ).toBe(true)
  })

  it('refuses the whole request when ANY target is not a transcript', async () => {
    expect(
      await searchTargetsGuard(
        { targets: [target('a'), `${HOME}/.ssh/id_rsa`] },
        conn('control'),
        ctx(),
      ),
    ).toBe(false)
  })

  it('refuses a session outside a grant limited to named sessions', async () => {
    const limited = conn('manager', ['a'])
    expect(await searchTargetsGuard({ targets: [target('a')] }, limited, ctx())).toBe(true)
    expect(await searchTargetsGuard({ targets: [target('a'), target('b')] }, limited, ctx())).toBe(false)
  })

  it('refuses a malformed payload', async () => {
    expect(await searchTargetsGuard(null, conn('control'), ctx())).toBe(false)
    expect(await searchTargetsGuard({ targets: 'x' }, conn('control'), ctx())).toBe(false)
    expect(await searchTargetsGuard({ targets: [42] }, conn('control'), ctx())).toBe(false)
  })

  it('fails closed when neither the runtime nor the host knows the home', async () => {
    expect(await searchTargetsGuard({ targets: [target('a')] }, conn('control'), ctx(''))).toBe(false)
  })

  it('resolves the home from the host when the runtime has none yet', async () => {
    // What the e2e suite found on a live desktop: `ctx.homeDir` is filled only
    // by a port attach that carries one, and was empty — so every remote
    // search answered `bad_payload`. The client built its paths from
    // `fsx.userHome`, which asks the host; the guard must ask the same way.
    const host = {
      request: async (route: { action: string }) =>
        route.action === 'userHome'
          ? { ok: true as const, result: HOME }
          : { ok: false as const, error: { code: 'not_found', message: 'x' } },
    }
    const context = { homeDir: '', host } as unknown as RuntimeContext
    expect(await searchTargetsGuard({ targets: [target('a')] }, conn('control'), context)).toBe(true)
  })

  it('does not narrow a full grant (this machine’s own shell)', async () => {
    expect(
      await searchTargetsGuard({ targets: [`${HOME}/anything.txt`] }, conn('full'), ctx('')),
    ).toBe(true)
  })
})
