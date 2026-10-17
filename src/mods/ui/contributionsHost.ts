/**
 * The realm's UI contributions (F-25): the templates and topbar items of the
 * person's plugins (user directory and marketplace, never a project's), read
 * from the manifest scan the provider-mod boot already makes. No worker
 * starts. Published on `mods/contributions`; a plugin whose `requires` is not
 * met contributes nothing and is listed as waiting.
 */

import type {
  ContributedTemplate,
  ContributedTopbarItem,
  ContributionIcon,
  ContributionWelcome,
  ModContributionsState,
  WaitingPlugin,
} from '../../browser/runtimeProtocol/modContributions'
import { joinRuntimePath } from '../../utils/runtimePaths'
import type { ActivePlugin } from '../../pluginHost/pluginModel'
import {
  pluginOwnerId,
  requirementsSignature,
  splitByRequirements,
  type ProviderGateState,
} from '../../pluginHost/pluginRequirements'
import { parseWelcome } from '../../prompting/templateParsing'
import { safeIconSvg } from '../provider/modProviderDefinition'
import { publishModContributions, setTopbarResolver } from './contributionsState'
import { modUiId, type ModUiIconDecl } from './uiManifest'

export type ContributingPlugin = Pick<
  ActivePlugin,
  'name' | 'path' | 'source' | 'installIdentifier' | 'manifest' | 'providers' | 'templates'
>

export type ContributionsHostOptions = {
  readText(path: string): Promise<string>
  /** File names directly under `path`; [] when it is absent. */
  listFiles(path: string): Promise<string[]>
  gate(): ProviderGateState
  report(line: string): void
}

/** Where a plugin's template is served from, for a session that uses it. */
export type PluginTemplateSource = { type: string; plugin: string; owner: string; dir: string }

export type PluginTemplateStatus =
  | { state: 'ready'; source: PluginTemplateSource }
  | { state: 'waiting'; plugin: string; providers: WaitingPlugin['providers'] }
  | { state: 'absent'; plugin: string }

/** What a topbar press runs, as the runtime resolved it. */
export type TopbarTarget = { plugin: string; command: string; args?: string }

const WELCOME_FILE = /^welcome(?:-([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*))?\.md$/

const isGlobalSource = (source: string): boolean => source.startsWith('user:') || source.startsWith('marketplace:')

const insideRoot = (root: string, relative: string): string =>
  joinRuntimePath(root, ...relative.replace(/^\.\//, '').split('/'))

async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].slice(0, 12).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** One plugin's files the state is built from, read at the scan. */
type PluginAssets = {
  /** Plugin-relative svg path → content hash; absent when unreadable or refused. */
  icons: Map<string, string>
  /** Template key → locale → welcome. */
  welcome: Map<string, Record<string, ContributionWelcome>>
}

export class ModUiContributionsHost {
  private options: ContributionsHostOptions | undefined
  private plugins: ContributingPlugin[] = []
  private assets = new Map<string, PluginAssets>()
  private iconTexts = new Map<string, string>()
  private current: ModContributionsState = { templates: [], topbar: [], icons: {}, waiting: [] }
  private currentJson = JSON.stringify(this.current)
  private gateSignature = ''
  private readonly changed = new Set<(state: ModContributionsState) => void>()
  private readonly gateChanged = new Set<() => void>()
  private syncing: Promise<void> = Promise.resolve()
  private synced = false
  private readonly syncedWaiters = new Set<() => void>()

  configure(options: ContributionsHostOptions): void {
    this.options = options
    setTopbarResolver(id => {
      const target = this.topbarTarget(id)
      if (target === 'waiting') return { kind: 'waiting' }
      return target ? { kind: 'run', ...target } : { kind: 'unknown' }
    })
  }

  state(): ModContributionsState {
    return this.current
  }

  onChanged(listener: (state: ModContributionsState) => void): () => void {
    this.changed.add(listener)
    return () => this.changed.delete(listener)
  }

  /** `listener` runs when some plugin moved between in effect and waiting. */
  onGateChanged(listener: () => void): () => void {
    this.gateChanged.add(listener)
    return () => this.gateChanged.delete(listener)
  }

  /** Take the plugins of a new scan. Serialized; never rejects. */
  sync(scan: { enabled: readonly ContributingPlugin[] }): Promise<void> {
    const run = this.syncing.then(() => this.syncNow(scan))
    this.syncing = run.catch(() => undefined)
    return run
  }

  /**
   * Settles once the first scan was taken (or failed), so a session restored
   * at boot does not read "absent" before the plugins were scanned. At once
   * when the host was never configured; at most `capMs` otherwise.
   */
  whenSynced(capMs = 10_000): Promise<void> {
    if (this.synced || !this.options) return Promise.resolve()
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(timer)
        this.syncedWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, capMs)
      this.syncedWaiters.add(done)
    })
  }

  /** The files `registerPluginType` takes for one template, keyed `<type>/…`. */
  async readTemplateFiles(source: PluginTemplateSource): Promise<Array<[string, string]>> {
    const options = this.options
    if (!options) throw new Error('the plugin contributions are not configured')
    const files: Array<[string, string]> = []
    files.push([`${source.type}/template.md`, await options.readText(joinRuntimePath(source.dir, 'template.md'))])
    const names = await options.listFiles(source.dir)
    if (names.includes('template-beta.md')) {
      files.push([`${source.type}/template-beta.md`, await options.readText(joinRuntimePath(source.dir, 'template-beta.md'))])
    }
    const includes = joinRuntimePath(source.dir, 'includes')
    for (const name of await options.listFiles(includes)) {
      if (!name.endsWith('.md')) continue
      files.push([`${source.type}/includes/${name}`, await options.readText(joinRuntimePath(includes, name))])
    }
    return files
  }

  /** The provider state changed: re-judge the gate over the last scan. */
  recheckGate(): void {
    if (!this.options) return
    const signature = requirementsSignature(this.plugins, this.options.gate())
    if (signature === this.gateSignature) return
    this.gateSignature = signature
    this.publish()
    for (const listener of [...this.gateChanged]) listener()
  }

  /** The template `type` as a session would get it now. */
  templateStatus(type: string): PluginTemplateStatus {
    const plugin = type.slice(0, type.indexOf(':'))
    const owner = this.plugins.find(entry => entry.name === plugin)
    if (!owner || !owner.templates?.some(template => template.type === type)) return { state: 'absent', plugin }
    const waiting = this.current.waiting.find(entry => entry.plugin === plugin)
    if (waiting) return { state: 'waiting', plugin, providers: waiting.providers }
    const template = owner.templates.find(entry => entry.type === type)!
    return { state: 'ready', source: { type, plugin, owner: pluginOwnerId(owner), dir: template.dir } }
  }

  /** What the topbar item `id` runs; undefined when no plugin in effect offers it. */
  topbarTarget(id: string): TopbarTarget | 'waiting' | undefined {
    const plugin = id.slice(0, id.indexOf(':'))
    const key = id.slice(id.indexOf(':') + 1)
    const owner = this.plugins.find(entry => entry.name === plugin)
    const decl = owner?.manifest.ui?.topbar?.[key]
    if (!owner || !decl) return undefined
    if (this.current.waiting.some(entry => entry.plugin === plugin)) return 'waiting'
    return { plugin, command: decl.command, ...(decl.args !== undefined ? { args: decl.args } : {}) }
  }

  private async syncNow(scan: { enabled: readonly ContributingPlugin[] }): Promise<void> {
    try {
      await this.take(scan)
    } finally {
      this.synced = true
      for (const waiter of [...this.syncedWaiters]) waiter()
    }
  }

  private async take(scan: { enabled: readonly ContributingPlugin[] }): Promise<void> {
    const options = this.options
    if (!options) return
    const plugins = scan.enabled.filter(
      plugin => isGlobalSource(plugin.source) && (plugin.templates?.length || plugin.manifest.ui?.topbar || plugin.manifest.requires),
    )
    const assets = new Map<string, PluginAssets>()
    for (const plugin of plugins) {
      try {
        assets.set(plugin.name, await this.readAssets(plugin, options))
      } catch (error) {
        options.report(`${plugin.name}: its icons and welcome pages were not read: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.plugins = plugins
    this.assets = assets
    const kept = new Set([...assets.values()].flatMap(entry => [...entry.icons.values()]))
    for (const hash of [...this.iconTexts.keys()]) if (!kept.has(hash)) this.iconTexts.delete(hash)
    this.gateSignature = requirementsSignature(plugins, options.gate())
    this.publish()
  }

  private async readAssets(plugin: ContributingPlugin, options: ContributionsHostOptions): Promise<PluginAssets> {
    const icons = new Map<string, string>()
    const decls: ModUiIconDecl[] = [
      ...(plugin.templates ?? []).flatMap(template => (template.decl.icon ? [template.decl.icon] : [])),
      ...Object.values(plugin.manifest.ui?.topbar ?? {}).flatMap(item => (item.icon ? [item.icon] : [])),
    ]
    const paths = new Set(decls.flatMap(icon => (icon.kind === 'file' ? [icon.src, ...(icon.dark ? [icon.dark] : [])] : [])))
    for (const relative of paths) {
      let text: string | undefined
      try {
        text = await options.readText(insideRoot(plugin.path, relative))
      } catch {
        options.report(`${plugin.name}: icon ${relative} not found; the generic icon is shown`)
        continue
      }
      const svg = safeIconSvg(text)
      if (svg === undefined) {
        options.report(`${plugin.name}: icon ${relative} is not a plain SVG of at most 64 KiB; the generic icon is shown`)
        continue
      }
      const hash = await contentHash(svg)
      this.iconTexts.set(hash, svg)
      icons.set(relative, hash)
    }
    const welcome = new Map<string, Record<string, ContributionWelcome>>()
    for (const template of plugin.templates ?? []) {
      const pages: Record<string, ContributionWelcome> = {}
      for (const name of await options.listFiles(template.dir)) {
        const match = WELCOME_FILE.exec(name)
        if (!match) continue
        try {
          pages[match[1] ?? ''] = parseWelcome(await options.readText(joinRuntimePath(template.dir, name)))
        } catch {
          options.report(`${plugin.name}: ${template.key}/${name} could not be read`)
        }
      }
      if (Object.keys(pages).length > 0) welcome.set(template.key, pages)
    }
    return { icons, welcome }
  }

  private publish(): void {
    const options = this.options
    if (!options) return
    const { effective, waiting } = splitByRequirements(this.plugins, options.gate())
    const used = new Set<string>()
    const iconOf = (plugin: string, decl: ModUiIconDecl | undefined): ContributionIcon | undefined => {
      if (!decl) return undefined
      if (decl.kind === 'lucide') return { lucide: decl.name }
      const icons = this.assets.get(plugin)?.icons
      const ref = icons?.get(decl.src)
      if (!ref) return undefined
      used.add(ref)
      const dark = decl.dark ? icons?.get(decl.dark) : undefined
      if (dark) used.add(dark)
      return { ref, ...(dark ? { dark } : {}), ...(decl.mask ? { mask: true as const } : {}) }
    }
    const templates: ContributedTemplate[] = []
    const topbar: ContributedTopbarItem[] = []
    for (const plugin of effective) {
      const owner = pluginOwnerId(plugin)
      for (const template of plugin.templates ?? []) {
        const icon = iconOf(plugin.name, template.decl.icon)
        const welcome = this.assets.get(plugin.name)?.welcome.get(template.key)
        templates.push({
          type: template.type,
          plugin: plugin.name,
          owner,
          title: template.decl.title,
          ...(template.decl.description ? { description: template.decl.description } : {}),
          ...(icon ? { icon } : {}),
          launcher: template.decl.launcher,
          ...(welcome ? { welcome } : {}),
        })
      }
      for (const [key, item] of Object.entries(plugin.manifest.ui?.topbar ?? {})) {
        const icon = iconOf(plugin.name, item.icon)
        topbar.push({ id: modUiId(plugin.name, key), plugin: plugin.name, title: item.title, ...(icon ? { icon } : {}) })
      }
    }
    const next: ModContributionsState = {
      templates,
      topbar,
      icons: Object.fromEntries([...used].sort().map(hash => [hash, this.iconTexts.get(hash)!])),
      waiting: waiting.map(({ plugin, unmet }) => {
        const unknown = unmet.flatMap(entry => (entry.kind === 'unknown' ? [entry.word] : []))
        return {
          plugin: plugin.name,
          owner: pluginOwnerId(plugin),
          providers: unmet.flatMap(entry =>
            entry.kind === 'provider' ? [{ key: entry.key, ...(entry.providerId ? { id: entry.providerId } : {}) }] : [],
          ),
          ...(unknown.length > 0 ? { unknown } : {}),
        }
      }),
    }
    const json = JSON.stringify(next)
    if (json === this.currentJson) return
    this.current = next
    this.currentJson = json
    publishModContributions(next)
    for (const listener of [...this.changed]) listener(next)
  }
}

const host = new ModUiContributionsHost()

export function getModUiContributionsHost(): ModUiContributionsHost {
  return host
}
