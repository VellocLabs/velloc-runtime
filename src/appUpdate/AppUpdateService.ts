/**
 * Client auto-update (F-30): check the channel's manifest, download the
 * package, run the install program, then wait for the person to restart.
 *
 * Contract: one check at a time; a check never throws (a failure is
 * `phase: 'failed'` with `lastError`). Once a package is installed the phase
 * stays `ready` until the app restarts into it.
 */
import type { AppUpdatePhase, AppUpdateState } from './appUpdateProtocol'
import { buildInstallScript, readInstallResult } from './installScript'
import { parseUpdateManifest, parseVersion, compareVersions, shouldInstall } from './updateManifest'

/** What the service needs from the host; every call may reject. */
export type AppUpdateHost = {
  currentVersion(): Promise<string>
  /** Directory the update files live under (created on demand). */
  updateRoot(): Promise<string>
  fetchText(url: string, maxBytes: number): Promise<{ status: number; text: string }>
  /** Stream `url` into `path`, replacing it. */
  download(url: string, path: string): Promise<void>
  mkdir(path: string): Promise<void>
  /** Resolves whether or not the file existed. */
  remove(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Null when the file does not exist. */
  readText(path: string): Promise<string | null>
  writeText(path: string, text: string): Promise<void>
  /** Start the PowerShell program detached from this connection; returns its id. */
  startInstall(script: string, logPath: string): Promise<string>
  /** Null when the host no longer lists the child. */
  installRunning(id: string): Promise<boolean | null>
  relaunch(): Promise<void>
}

export type AppUpdateServiceOptions = {
  host: AppUpdateHost
  manifestUrl: string
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  sleep?: (ms: number) => Promise<void>
  firstCheckDelayMs?: number
  checkIntervalMs?: number
  installPollMs?: number
  installTimeoutMs?: number
  report?: (line: string) => void
}

const MANIFEST_MAX_BYTES = 64 * 1024
const INSTALLER_NAME = 'mini_installer.exe'
const INSTALLED_MARKER = 'installed.json'

export class AppUpdateService {
  private state: AppUpdateState = { available: true, phase: 'idle' }
  private readonly listeners = new Set<(state: AppUpdateState) => void>()
  private running: Promise<void> | null = null
  private timer: unknown = null
  private disposed = false
  private readonly host: AppUpdateHost
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: AppUpdateServiceOptions) {
    this.host = options.host
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  getState(): AppUpdateState {
    return { ...this.state }
  }

  onStateChange(listener: (state: AppUpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Schedule the first check and every later one. */
  start(): void {
    this.schedule(this.options.firstCheckDelayMs ?? 5 * 60_000)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.listeners.clear()
  }

  /** Run one check now, or join the one in flight. */
  check(): Promise<void> {
    if (!this.running) {
      this.running = this.runCheck().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  /** Restart into the installed package. Rejects unless the phase is `ready`. */
  async relaunch(): Promise<void> {
    if (this.state.phase !== 'ready') throw new Error('no installed update is waiting for a restart')
    await this.host.relaunch()
  }

  private schedule(ms: number): void {
    if (this.disposed) return
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.check().finally(() => this.schedule(this.options.checkIntervalMs ?? 6 * 60 * 60_000))
    }, ms)
  }

  private update(patch: Partial<AppUpdateState> & { phase: AppUpdatePhase }): void {
    if (this.disposed) return
    const next: AppUpdateState = { ...this.state, ...patch }
    if (patch.phase !== 'failed') delete next.lastError
    this.state = next
    for (const listener of [...this.listeners]) {
      try {
        listener(this.getState())
      } catch (error) {
        this.report(`a state listener failed: ${messageOf(error)}`)
      }
    }
  }

  private report(line: string): void {
    ;(this.options.report ?? (text => console.warn(`[app-update] ${text}`)))(line)
  }

  private async runCheck(): Promise<void> {
    // An installed package only takes effect on restart; nothing more to do until then.
    if (this.state.phase === 'ready') return
    try {
      this.update({ phase: 'checking' })
      const current = await this.host.currentVersion()
      this.update({ phase: 'checking', current })

      const response = await this.host.fetchText(this.options.manifestUrl, MANIFEST_MAX_BYTES)
      if (response.status !== 200) throw new Error(`manifest request answered ${response.status}`)
      let json: unknown
      try {
        json = JSON.parse(response.text)
      } catch {
        throw new Error('manifest is not JSON')
      }
      const manifest = parseUpdateManifest(json)
      if ('error' in manifest) throw new Error(manifest.error)
      const checkedAt = this.now()
      if (!shouldInstall(current, manifest)) {
        this.update({ phase: 'idle', checkedAt, target: undefined })
        return
      }

      const root = await this.host.updateRoot()
      const dir = joinPath(root, manifest.version)
      if (await this.alreadyInstalled(dir, manifest.version, current)) {
        this.update({ phase: 'ready', checkedAt, target: manifest.version })
        return
      }

      this.update({ phase: 'downloading', checkedAt, target: manifest.version })
      await this.host.mkdir(dir)
      const installer = joinPath(dir, INSTALLER_NAME)
      const partial = `${installer}.part`
      await this.host.remove(partial)
      await this.host.download(manifest.url, partial)
      await this.host.remove(installer)
      await this.host.rename(partial, installer)

      this.update({ phase: 'installing' })
      const resultPath = joinPath(dir, 'result.json')
      await this.host.remove(resultPath)
      const script = buildInstallScript({ installerPath: installer, version: manifest.version, resultPath })
      const id = await this.host.startInstall(script, joinPath(dir, 'install.log'))
      await this.waitForInstall(id)

      const result = readInstallResult((await this.host.readText(resultPath)) ?? '')
      if (!result) throw new Error('install program left no result')
      if (result.code !== 'exited') throw new Error(`install refused: ${result.code}${result.detail ? ` (${result.detail})` : ''}`)
      if (result.pv !== manifest.version) {
        throw new Error(`installer exited ${result.detail}; installed version is ${result.pv || 'unknown'}`)
      }
      await this.host.writeText(joinPath(dir, INSTALLED_MARKER), JSON.stringify({ version: manifest.version }))
      await this.host.remove(installer)
      this.update({ phase: 'ready' })
    } catch (error) {
      const lastError = messageOf(error)
      this.report(`check failed: ${lastError}`)
      this.update({ phase: 'failed', lastError })
    }
  }

  /** A previous runtime in this app run already installed `version`. */
  private async alreadyInstalled(dir: string, version: string, current: string): Promise<boolean> {
    const own = parseVersion(current)
    const target = parseVersion(version)
    if (!own || !target || compareVersions(own, target) >= 0) return false
    const marker = await this.host.readText(joinPath(dir, INSTALLED_MARKER)).catch(() => null)
    if (!marker) return false
    try {
      return (JSON.parse(marker) as { version?: unknown }).version === version
    } catch {
      return false
    }
  }

  private async waitForInstall(id: string): Promise<void> {
    const poll = this.options.installPollMs ?? 2_000
    const deadline = this.now() + (this.options.installTimeoutMs ?? 15 * 60_000)
    for (;;) {
      const running = await this.host.installRunning(id)
      if (running !== true) return
      if (this.now() >= deadline) throw new Error('install did not finish in time')
      await this.sleep(poll)
    }
  }
}

/** Joins with the separator the root already uses. */
export function joinPath(root: string, name: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return root.endsWith(sep) ? `${root}${name}` : `${root}${sep}${name}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
