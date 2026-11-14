import { describe, expect, it } from 'vitest'
import { AppUpdateService, type AppUpdateHost } from '../../appUpdate/AppUpdateService'
import type { AppUpdateState } from '../../appUpdate/appUpdateProtocol'

const ROOT = String.raw`C:\Users\u\AppData\Local\Velloc\Update`
const PKG = 'https://github.com/VellocLabs/velloc-bootstrap/releases/download/velloc-v1.149.2.5/mini_installer.exe'

type Script = {
  current?: string
  manifest?: { status: number; text: string }
  result?: { code: string; detail: string; pv: string } | null
  runningPolls?: number
  failDownload?: boolean
  /** Directory names under ROOT. */
  dirs?: string[]
  failList?: boolean
  failRemove?: string
  failRoot?: boolean
}

function fakeHost(script: Script = {}) {
  const files = new Map<string, string>()
  const calls: string[] = []
  const dirs = new Set(script.dirs ?? [])
  let polls = script.runningPolls ?? 1
  let lastScript = ''
  const host: AppUpdateHost = {
    currentVersion: async () => script.current ?? '1.149.2.4',
    updateRoot: async () => {
      if (script.failRoot) throw new Error('the host has no local cache directory')
      return ROOT
    },
    fetchText: async url => {
      calls.push(`fetch ${url}`)
      return script.manifest ?? { status: 200, text: JSON.stringify({ version: '1.149.2.5', url: PKG }) }
    },
    download: async (url, path) => {
      calls.push(`download ${url} -> ${path}`)
      if (script.failDownload) throw new Error('download failed: net::ERR_CONNECTION_RESET')
      files.set(path, 'MZ')
    },
    mkdir: async path => {
      calls.push(`mkdir ${path}`)
    },
    remove: async path => {
      files.delete(path)
    },
    listDirectories: async path => {
      if (script.failList) throw new Error('EACCES: access denied')
      return path === ROOT ? [...dirs] : []
    },
    removeDirectory: async path => {
      calls.push(`rmdir ${path}`)
      if (script.failRemove && path.endsWith(script.failRemove)) throw new Error('EBUSY: in use')
      dirs.delete(path.slice(ROOT.length + 1))
    },
    rename: async (from, to) => {
      calls.push(`rename ${from} -> ${to}`)
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    readText: async path => files.get(path) ?? null,
    writeText: async (path, text) => {
      files.set(path, text)
    },
    startInstall: async (text, logPath) => {
      lastScript = text
      calls.push(`install log=${logPath}`)
      const result = script.result === undefined ? { code: 'exited', detail: '0', pv: '1.149.2.5' } : script.result
      if (result) files.set(`${ROOT}\\1.149.2.5\\result.json`, JSON.stringify(result))
      return 'p1'
    },
    installRunning: async () => {
      polls -= 1
      return polls > 0
    },
    relaunch: async () => {
      calls.push('relaunch')
    },
  }
  return { host, files, calls, dirs, script: () => lastScript }
}

function service(host: AppUpdateHost) {
  const states: AppUpdateState[] = []
  const svc = new AppUpdateService({
    host,
    manifestUrl: 'https://velloc.app/update/stable.json',
    now: () => 1_000,
    sleep: async () => {},
    report: () => {},
  })
  svc.onStateChange(state => states.push(state))
  return { svc, states }
}

describe('AppUpdateService', () => {
  it('downloads, installs and waits for a restart when the client is below the release', async () => {
    const fake = fakeHost({ runningPolls: 3 })
    const { svc, states } = service(fake.host)
    await svc.check()
    expect(states.map(s => s.phase)).toEqual(['checking', 'checking', 'downloading', 'installing', 'ready'])
    expect(svc.getState()).toMatchObject({ phase: 'ready', current: '1.149.2.4', target: '1.149.2.5', checkedAt: 1_000 })
    const dir = `${ROOT}\\1.149.2.5`
    expect(fake.calls).toEqual([
      'fetch https://velloc.app/update/stable.json',
      `mkdir ${dir}`,
      `download ${PKG} -> ${dir}\\mini_installer.exe.part`,
      `rename ${dir}\\mini_installer.exe.part -> ${dir}\\mini_installer.exe`,
      `install log=${dir}\\install.log`,
    ])
    expect(fake.script()).toContain(`$installer = '${dir}\\mini_installer.exe'`)
    // The package is gone once installed; the marker stays.
    expect(fake.files.has(`${dir}\\mini_installer.exe`)).toBe(false)
    expect(JSON.parse(fake.files.get(`${dir}\\installed.json`)!)).toEqual({ version: '1.149.2.5' })
  })

  it('does nothing when the client is current', async () => {
    const fake = fakeHost({ current: '1.149.2.5' })
    const { svc } = service(fake.host)
    await svc.check()
    expect(svc.getState()).toMatchObject({ phase: 'idle', current: '1.149.2.5', checkedAt: 1_000 })
    expect(fake.calls).toEqual(['fetch https://velloc.app/update/stable.json'])
  })

  it('each check first deletes version directories at or below the running version', async () => {
    const dirs = ['1.149.2.3', '1.149.2.4', '1.149.2.5', '1.150.0.0', 'notes', '1.149']
    const fake = fakeHost({ current: '1.149.2.5', dirs })
    const { svc } = service(fake.host)
    await svc.check()
    expect(fake.calls).toEqual([
      `rmdir ${ROOT}\\1.149.2.3`,
      `rmdir ${ROOT}\\1.149.2.4`,
      `rmdir ${ROOT}\\1.149.2.5`,
      'fetch https://velloc.app/update/stable.json',
    ])
    expect([...fake.dirs]).toEqual(['1.150.0.0', 'notes', '1.149'])
    expect(svc.getState().phase).toBe('idle')
  })

  it('a failed cleanup is reported but never fails the check', async () => {
    const lines: string[] = []
    const remove = fakeHost({ current: '1.149.2.5', dirs: ['1.149.2.3', '1.149.2.4'], failRemove: '1.149.2.3' })
    const svc = new AppUpdateService({
      host: remove.host,
      manifestUrl: 'https://velloc.app/update/stable.json',
      report: line => lines.push(line),
    })
    await svc.check()
    expect(svc.getState().phase).toBe('idle')
    expect([...remove.dirs]).toEqual(['1.149.2.3'])
    expect(lines).toEqual(['could not remove 1.149.2.3: EBUSY: in use'])

    const list = fakeHost({ current: '1.149.2.5', failList: true })
    const second = service(list.host)
    await second.svc.check()
    expect(second.svc.getState().phase).toBe('idle')
    expect(list.calls).toEqual(['fetch https://velloc.app/update/stable.json'])
  })

  it('reports an update directory it cannot resolve as that, not as a listing failure', async () => {
    const lines: string[] = []
    const fake = fakeHost({ current: '1.149.2.5', dirs: ['1.149.2.3'], failRoot: true })
    const svc = new AppUpdateService({
      host: fake.host,
      manifestUrl: 'https://velloc.app/update/stable.json',
      report: line => lines.push(line),
    })
    await svc.check()
    expect(svc.getState().phase).toBe('idle')
    expect(lines).toEqual(['could not find the update directory: the host has no local cache directory'])
    expect(fake.calls).toEqual(['fetch https://velloc.app/update/stable.json'])
  })

  it('honours min_version: a client at or above it is left alone', async () => {
    const manifest = { status: 200, text: JSON.stringify({ version: '1.149.2.5', min_version: '1.149.2.3', url: PKG }) }
    const fake = fakeHost({ current: '1.149.2.4', manifest })
    const { svc } = service(fake.host)
    await svc.check()
    expect(svc.getState().phase).toBe('idle')
    expect(fake.calls.some(c => c.startsWith('download'))).toBe(false)
  })

  it('a refused install is failed with the reason; nothing waits for a restart', async () => {
    const fake = fakeHost({ result: { code: 'signature_invalid', detail: 'NotSigned', pv: '1.149.2.4' } })
    const { svc } = service(fake.host)
    await svc.check()
    expect(svc.getState()).toMatchObject({ phase: 'failed', lastError: 'install refused: signature_invalid (NotSigned)' })
    await expect(svc.relaunch()).rejects.toThrow('no installed update')
  })

  it('an installer that exits without registering the new version is failed', async () => {
    const fake = fakeHost({ result: { code: 'exited', detail: '7', pv: '1.149.2.4' } })
    const { svc } = service(fake.host)
    await svc.check()
    expect(svc.getState()).toMatchObject({
      phase: 'failed',
      lastError: 'installer exited 7; installed version is 1.149.2.4',
    })
  })

  it('a missing result file, a bad manifest and a failed download are failures, not throws', async () => {
    for (const script of [
      { result: null },
      { manifest: { status: 404, text: '' } },
      { manifest: { status: 200, text: '{"version":"1.149.2.5","url":"http://x/y.exe"}' } },
      { failDownload: true },
    ] satisfies Script[]) {
      const { svc } = service(fakeHost(script).host)
      await expect(svc.check()).resolves.toBeUndefined()
      expect(svc.getState().phase).toBe('failed')
    }
  })

  it('an install already done by an earlier runtime goes straight to ready', async () => {
    const fake = fakeHost()
    fake.files.set(`${ROOT}\\1.149.2.5\\installed.json`, JSON.stringify({ version: '1.149.2.5' }))
    const { svc } = service(fake.host)
    await svc.check()
    expect(svc.getState()).toMatchObject({ phase: 'ready', target: '1.149.2.5' })
    expect(fake.calls).toEqual(['fetch https://velloc.app/update/stable.json'])
  })

  it('once ready, later checks do nothing and relaunch reaches the host', async () => {
    const fake = fakeHost()
    const { svc } = service(fake.host)
    await svc.check()
    const before = fake.calls.length
    await svc.check()
    expect(fake.calls.length).toBe(before)
    await svc.relaunch()
    expect(fake.calls.at(-1)).toBe('relaunch')
  })

  it('concurrent checks share one run', async () => {
    const fake = fakeHost()
    const { svc } = service(fake.host)
    await Promise.all([svc.check(), svc.check()])
    expect(fake.calls.filter(c => c.startsWith('fetch'))).toHaveLength(1)
  })

  it('an install that never finishes times out', async () => {
    let clock = 0
    const fake = fakeHost({ runningPolls: Number.POSITIVE_INFINITY })
    const svc = new AppUpdateService({
      host: fake.host,
      manifestUrl: 'https://velloc.app/update/stable.json',
      now: () => clock,
      sleep: async ms => {
        clock += ms
      },
      installTimeoutMs: 10_000,
      installPollMs: 2_000,
      report: () => {},
    })
    await svc.check()
    expect(svc.getState()).toMatchObject({ phase: 'failed', lastError: 'install did not finish in time' })
  })

  it('start schedules the first check, then every interval', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = []
    const fake = fakeHost({ current: '1.149.2.5' })
    const svc = new AppUpdateService({
      host: fake.host,
      manifestUrl: 'https://velloc.app/update/stable.json',
      setTimer: (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length
      },
      clearTimer: () => {},
      firstCheckDelayMs: 300_000,
      checkIntervalMs: 21_600_000,
      report: () => {},
    })
    svc.start()
    expect(timers.map(t => t.ms)).toEqual([300_000])
    timers[0].fn()
    await svc.check()
    await Promise.resolve()
    expect(timers.map(t => t.ms)).toEqual([300_000, 21_600_000])
    expect(fake.calls.filter(c => c.startsWith('fetch'))).toHaveLength(1)
    svc.dispose()
  })
})
