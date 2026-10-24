/**
 * A deleted CLI session's conversation leaves its CLI's own logs (F-34):
 * only that conversation's log (and its same-named folder) is removed.
 */
import { describe, expect, it } from 'vitest'
import type { BrowserBridgeRequest } from '../browser/bridge/browserBridgeProtocol'
import { sourceRoot } from '../browser/bridge/adapter/sessionImportBridgeAdapter'
import { CLI_AGENT_IDS } from '../terminal/cliAgents'
import { createBridgeCliLogEraser, isDatedLogOf } from '../terminal/cliLogErase'
import { cliLogSource } from '../terminal/cliLogs'
import { TerminalService } from '../terminal/TerminalService'
import { projectFolderKey } from '../utils/conversationStoragePaths'
import { fakePtyHost, ok, fail, PTY_MANIFEST, routeOf } from './_helpers/fakePtyHost'

const OTHER_CLI = CLI_AGENT_IDS.find(id => id !== 'codex')!
const ID_A = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const ID_B = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c'
const HOME = 'C:\\Users\\me'
const norm = (path: string) => path.replace(/\\/g, '/')

/** A host whose disk holds `paths` (a trailing `/` is a folder); `rm` removes, `failRm` fails that many times. */
function diskHost(paths: string[], options: { failRm?: number } = {}) {
  const disk = new Set(paths.map(norm))
  let failRm = options.failRm ?? 0
  const fake = fakePtyHost({
    answer: (request: BrowserBridgeRequest) => {
      const payload = request.payload as { path?: string; maxDepth?: number; recursive?: boolean }
      switch (routeOf(request)) {
        case 'shell.env':
          return ok({ values: { PATH: '', USERPROFILE: HOME, HOME: null, APPDATA: null } })
        case 'fs.readdirTree': {
          const dir = `${norm(payload.path!)}/`
          const depth = payload.maxDepth ?? 1
          const entries = [...disk]
            .filter(path => path.startsWith(dir))
            .map(path => path.slice(dir.length))
            .filter(rest => rest.replace(/\/$/, '').split('/').length <= depth)
            .map(rest => ({ path: rest.replace(/\/$/, ''), isDirectory: rest.endsWith('/'), size: 1, mtimeMs: 0 }))
          return entries.length > 0 ? ok({ entries }) : fail('NOT_FOUND')
        }
        case 'fs.rm': {
          if (failRm > 0) {
            failRm -= 1
            return fail('EBUSY')
          }
          const target = norm(payload.path!)
          for (const path of [...disk]) {
            if (path === target || path === `${target}/` || (payload.recursive && path.startsWith(`${target}/`))) {
              disk.delete(path)
            }
          }
          return ok({})
        }
        default:
          return undefined
      }
    },
  })
  const manifest = { ...PTY_MANIFEST!, primitives: [...PTY_MANIFEST!.primitives!, 'shell.env'] }
  return { ...fake, disk, host: () => fake.host(manifest) }
}

const noWait = async () => {}

describe('erasing a deleted CLI session’s conversation', () => {
  it('names a dated log by the id at the end of its file name', () => {
    expect(isDatedLogOf(`2026/10/23/rollout-2026-10-23T10-00-03-${ID_A}.jsonl`, ID_A)).toBe(true)
    expect(isDatedLogOf(`${ID_A}.jsonl`, ID_A)).toBe(true)
    expect(isDatedLogOf(`rollout-${ID_A}.jsonl.bak`, ID_A)).toBe(false)
    expect(isDatedLogOf(`rollout-x${ID_A}.jsonl`, ID_A)).toBe(false)
  })

  it('removes a Codex conversation’s log from its day folder and leaves the others', async () => {
    const root = norm(sourceRoot(HOME, cliLogSource('codex')))
    const mine = `${root}/2026/10/23/rollout-2026-10-23T10-00-03-${ID_A}.jsonl`
    const other = `${root}/2026/10/23/rollout-2026-10-23T11-00-00-${ID_B}.jsonl`
    const fake = diskHost([mine, other])
    const removed = await createBridgeCliLogEraser(fake.host, () => 'r', noWait).erase('codex', {
      cwd: 'D:\\work\\api',
      id: ID_A,
    })
    expect(removed.map(norm)).toEqual([mine])
    expect([...fake.disk]).toEqual([other])
  })

  it('removes the other CLI’s log and its same-named folder from the session’s project folder only', async () => {
    const dir = `${norm(sourceRoot(HOME, cliLogSource(OTHER_CLI)))}/${projectFolderKey('D:\\work\\api')}`
    const elsewhere = `${norm(sourceRoot(HOME, cliLogSource(OTHER_CLI)))}/${projectFolderKey('D:\\work\\web')}/${ID_A}.jsonl`
    const fake = diskHost([`${dir}/${ID_A}.jsonl`, `${dir}/${ID_A}/`, `${dir}/${ID_A}/subagents/x.jsonl`, `${dir}/${ID_B}.jsonl`, elsewhere])
    await createBridgeCliLogEraser(fake.host, () => 'r', noWait).erase(OTHER_CLI, { cwd: 'D:\\work\\api\\', id: ID_A })
    expect([...fake.disk].sort()).toEqual([`${dir}/${ID_B}.jsonl`, elsewhere].sort())
  })

  it('tries a failed removal once more, and never touches a path for an id that is not a conversation id', async () => {
    const dir = `${norm(sourceRoot(HOME, cliLogSource(OTHER_CLI)))}/${projectFolderKey('D:\\work\\api')}`
    const busy = diskHost([`${dir}/${ID_A}.jsonl`], { failRm: 1 })
    await createBridgeCliLogEraser(busy.host, () => 'r', noWait).erase(OTHER_CLI, { cwd: 'D:\\work\\api', id: ID_A })
    expect([...busy.disk]).toEqual([])

    const fake = diskHost([`${dir}/x.jsonl`])
    expect(await createBridgeCliLogEraser(fake.host, () => 'r', noWait).erase(OTHER_CLI, { cwd: 'D:\\work\\api', id: '../x' })).toEqual([])
    expect(fake.requests.some(r => routeOf(r) === 'fs.rm' || routeOf(r) === 'fs.readdirTree')).toBe(false)
  })

  it('the terminal service erases through its eraser only for a recorded id', async () => {
    const erased: unknown[] = []
    const service = new TerminalService({
      host: () => fakePtyHost().host(),
      createRequestId: () => 'r',
      sessionCwd: () => undefined,
      cliLogEraser: {
        erase: async (cli, where) => {
          erased.push({ cli, ...where })
          return []
        },
      },
    })
    await service.eraseCliConversation({ cli: 'codex', id: null }, 'D:\\work\\api')
    await service.eraseCliConversation({ cli: 'codex', id: ID_A }, 'D:\\work\\api')
    expect(erased).toEqual([{ cli: 'codex', cwd: 'D:\\work\\api', id: ID_A }])
    service.dispose()
  })
})
