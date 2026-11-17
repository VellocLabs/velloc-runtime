/**
 * VALIDATE (F-25): a static check of a plugin folder, read the way the loader
 * reads it — the manifest and `hooks/hooks.json` through `assemblePluginAt`, each
 * module through the compiler and the scan, the registrations against the
 * admission table. It runs nothing of the mod and is not a security boundary.
 * Security: every path is read through `ModValidateDeps.gate` first; a path the
 * gate refuses is not read and is reported. Nothing is written.
 */

import type * as TS from 'typescript'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { basenameRuntimePath, joinRuntimePath, normalizeRuntimePath } from '../utils/runtimePaths'
import { assemblePluginAt } from '../pluginHost/loadPlugins'
import { describePluginError } from '../pluginHost/pluginModel'
import { getPluginManifestPath } from '../pluginHost/pluginPaths'
import {
  REFUSING_EVENTS,
  isPluginNounPattern,
  proposedEventsHooked,
  refuseModuleSource,
  refuseProviderModuleUses,
  refuseProviderRegistrations,
  refuseRegistrations,
  unraisedRenderSites,
} from './modAdmission'
import { ModCompileError, compileModModule, loadTypeScript as defaultLoadTypeScript } from './modCompiler'
import { implementedNouns } from './modNouns'
import { pluginNounCalls, unsupportedEngineCalls, type ModUses, type ScannedStateName } from './modScan'
import { asHookRegistrations, readRegistrations, type StaticEngineStep } from './modValidateHooks'
import { runsOn } from './chainRules'

/**
 * `refused`: the loader will not load it. `error`: it loads, but fails where
 * it is used, or cannot be checked here. `warning`: it loads and works, with a
 * risk named. `note`: information.
 */
export type ModValidateLevel = 'refused' | 'error' | 'warning' | 'note'

export type ModValidateFinding = {
  level: ModValidateLevel
  code: string
  message: string
  file?: string
  line?: number
}

export type ModValidateHook = {
  event: string
  file: string
  line: number
  form: 'function' | 'generator'
  hasCatch: boolean
  /** Its answer can refuse the action (`REFUSING_EVENTS`). */
  guards: boolean
}

export type ModValidateModule = {
  path: string
  kind: 'hooks' | 'provider'
  files: string[]
  hooks: ModValidateHook[]
  calls: string[]
  engineCreate: Array<Pick<StaticEngineStep, 'file' | 'line' | 'form' | 'adds'>>
  state?: { reads: ScannedStateName[]; writes: ScannedStateName[] }
}

export type ModValidateReport = {
  folder: string
  plugin: string | null
  /** No `refused` and no `error` finding. */
  ok: boolean
  modules: ModValidateModule[]
  findings: ModValidateFinding[]
}

export type ModValidateDeps = {
  fs: RuntimeFs
  /** Throws when `path` may not be read; its message is reported. */
  gate: (path: string) => Promise<void>
  loadTypeScript?: () => Promise<typeof TS>
}

class GateRefusal extends Error {}

/** A read-only view of `fs` whose every read passes `gate` first. */
function gatedFs(fs: RuntimeFs, gate: (path: string) => Promise<void>, refused: Map<string, string>): RuntimeFs {
  const check = async (path: string): Promise<void> => {
    try {
      await gate(path)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      refused.set(path, reason)
      throw new GateRefusal(reason)
    }
  }
  const reads = new Set(['readFile', 'readFileBytes', 'readRange', 'stat', 'lstat', 'readdir', 'realpath'])
  return new Proxy(fs, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver) as unknown
      if (typeof value !== 'function' || typeof name !== 'string') return value
      if (reads.has(name)) {
        return async (path: string, ...rest: unknown[]) => {
          await check(path)
          return (value as (...args: unknown[]) => unknown).apply(target, [path, ...rest])
        }
      }
      if (name === 'cwd') return value.bind(target)
      return () => {
        throw new GateRefusal(`${name} is not available while validating`)
      }
    },
  })
}

/** Every path of a report is spelled with `/`, whatever the host's separator. */
const slashed = (path: string): string => path.replace(/\\/g, '/')

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Validate the plugin at `folder` (absolute). Never throws: every problem is a finding. */
export async function validateModFolder(folder: string, deps: ModValidateDeps): Promise<ModValidateReport> {
  const root = normalizeRuntimePath(folder)
  const findings: ModValidateFinding[] = []
  const modules: ModValidateModule[] = []
  const refused = new Map<string, string>()
  const fs = gatedFs(deps.fs, deps.gate, refused)
  const report = (plugin: string | null): ModValidateReport => {
    for (const [path, reason] of refused) {
      findings.push({ level: 'error', code: 'not-readable', message: `not read: ${reason}`, file: path })
    }
    const ok = !findings.some(finding => finding.level === 'refused' || finding.level === 'error')
    return {
      folder: slashed(root),
      plugin,
      ok,
      modules: modules.map(module => ({
        ...module,
        path: slashed(module.path),
        files: module.files.map(slashed),
        hooks: module.hooks.map(hook => ({ ...hook, file: slashed(hook.file) })),
        engineCreate: module.engineCreate.map(step => ({ ...step, file: slashed(step.file) })),
      })),
      findings: findings.map(finding => (finding.file === undefined ? finding : { ...finding, file: slashed(finding.file) })),
    }
  }

  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) {
      findings.push({ level: 'refused', code: 'not-a-folder', message: 'not a folder', file: root })
      return report(null)
    }
  } catch (error) {
    if (!(error instanceof GateRefusal)) findings.push({ level: 'refused', code: 'not-a-folder', message: `no folder here (${errorText(error)})`, file: root })
    return report(null)
  }

  const folderName = basenameRuntimePath(root)
  const { plugin, errors } = await assemblePluginAt(root, `validate:${root}`, true, folderName, fs)
  const manifestPath = getPluginManifestPath(root)
  if (!(await fs.stat(manifestPath).then(() => true, () => false))) {
    findings.push({ level: 'warning', code: 'no-manifest', message: `no plugin manifest: the plugin is named after its folder ("${folderName}")`, file: manifestPath })
  }
  for (const issue of errors) {
    if (refused.size > 0 && issue.type === 'path-not-found' && refused.has(issue.path)) continue
    findings.push({ level: 'refused', code: 'manifest', message: describePluginError(issue) })
  }
  const hookModules = plugin.hookModules ?? []
  const providerModules = (plugin.providers ?? []).map(provider => provider.modulePath)
  if (hookModules.length === 0 && providerModules.length === 0) {
    findings.push({
      level: 'note',
      code: 'no-modules',
      message: 'no hooks modules: list them under "modules" in hooks/hooks.json',
      file: joinRuntimePath(root, 'hooks', 'hooks.json'),
    })
  }

  let ts: typeof TS | undefined
  const loadTs = async (): Promise<typeof TS> => (ts ??= await (deps.loadTypeScript ?? defaultLoadTypeScript)())
  const ownNouns = new Set<string>()
  const nounCalls: Array<{ noun: string; call: string; module: string }> = []
  for (const [path, kind] of [
    ...hookModules.map(path => [path, 'hooks'] as const),
    ...providerModules.map(path => [path, 'provider'] as const),
  ]) {
    const checked = await validateModule(path, kind, root, plugin.name, fs, loadTs, findings)
    if (!checked) continue
    modules.push(checked.module)
    for (const step of checked.module.engineCreate) for (const noun of step.adds) ownNouns.add(noun)
    for (const call of pluginNounCalls(checked.uses)) nounCalls.push({ ...call, module: path })
  }
  for (const { noun, call, module } of nounCalls) {
    if (ownNouns.has(noun)) continue
    findings.push({
      level: 'warning',
      code: 'plugin-noun',
      message: `$.${call} is a plugin's noun: it works only while a plugin whose engine.create adds $.${noun} is loaded`,
      file: module,
    })
  }
  return report(plugin.name)
}

async function validateModule(
  path: string,
  kind: 'hooks' | 'provider',
  root: string,
  pluginName: string,
  fs: RuntimeFs,
  loadTs: () => Promise<typeof TS>,
  findings: ModValidateFinding[],
): Promise<{ module: ModValidateModule; uses: ModUses } | null> {
  const refuse = (message: string, code: string, where: { file?: string; line?: number } = { file: path }): null => {
    findings.push({ level: 'refused', code, message, ...where })
    return null
  }
  let source: string
  try {
    source = await fs.readFile(path, { encoding: 'utf-8' })
  } catch (error) {
    if (error instanceof GateRefusal) return null
    return refuse(`could not be read (${errorText(error)})`, 'unreadable')
  }
  const refusedSource = refuseModuleSource(path, source, true)
  if (refusedSource) return refuse(refusedSource, 'source')
  const ts = await loadTs()
  let compiled
  try {
    compiled = await compileModModule({ entry: path, root, fs, entrySource: source, loadTypeScript: async () => ts })
  } catch (error) {
    if (error instanceof GateRefusal) return null
    if (error instanceof ModCompileError) {
      return refuse(error.message, 'compile', {
        ...(error.file !== undefined ? { file: error.file } : { file: path }),
        ...(error.line !== undefined ? { line: error.line } : {}),
      })
    }
    return refuse(`it did not compile — ${errorText(error)}`, 'compile')
  }
  const texts = await Promise.all(compiled.files.map(async file => ({ path: file, text: file === path ? source : await fs.readFile(file, { encoding: 'utf-8' }) })))
  const statics = readRegistrations(ts, texts)
  const uses = compiled.uses
  for (const unread of statics.unread) {
    findings.push({ level: 'warning', code: 'pattern-not-literal', message: 'its pattern is not a string literal: checked only at load', ...unread })
  }

  const module: ModValidateModule = {
    path,
    kind,
    files: compiled.files,
    hooks: statics.hooks.map(hook => ({
      event: hook.pattern,
      file: hook.file,
      line: hook.line,
      form: hook.streams ? 'generator' : 'function',
      hasCatch: hook.hasCatch,
      guards: !hook.pattern.startsWith('!') && REFUSING_EVENTS.some(event => runsOn({ pattern: hook.pattern }, event)),
    })),
    calls: [...uses.calls],
    engineCreate: statics.engineSteps.map(({ file, line, form, adds }) => ({ file, line, form, adds })),
    ...(uses.state ? { state: { reads: [...uses.state.reads], writes: [...uses.state.writes] } } : {}),
  }

  for (const hook of statics.hooks) {
    const at = { file: hook.file, line: hook.line }
    if (hook.matcherNotObject) findings.push({ level: 'refused', code: 'matcher', message: `on("${hook.pattern}"): the matcher is not an object (a partial of the event's argument)`, ...at })
    if (hook.hasCatch && hook.pattern === 'engine.create') findings.push({ level: 'refused', code: 'catch', message: 'on("engine.create") takes no .catch', ...at })
    if (hook.catchFormMismatch) findings.push({ level: 'refused', code: 'catch', message: `on("${hook.pattern}").catch: the handler's form (async generator or not) differs from the hook's`, ...at })
  }
  const registrations = asHookRegistrations(statics.hooks)
  if (kind === 'provider') {
    const reason = refuseProviderRegistrations(registrations) ?? refuseProviderModuleUses(uses)
    if (reason) refuse(reason, 'admission')
    return { module, uses }
  }

  const unsupported = unsupportedEngineCalls(uses, implementedNouns())
  if (unsupported.length > 0) {
    refuse(`it calls ${unsupported.map(call => `$.${call}`).join(', ')}, which this engine does not implement`, 'unsupported-call')
  }
  const tentative = registrations.map(hook => hook.pattern).filter(isPluginNounPattern)
  const refusedHooks = refuseRegistrations(registrations, tentative)
  if (refusedHooks) refuse(refusedHooks, 'unraised-event')
  for (const pattern of tentative) {
    findings.push({ level: 'note', code: 'plugin-noun-event', message: `${pattern} is raised only while a plugin that adds $.${pattern.slice(0, pattern.indexOf('.'))} is loaded`, file: path })
  }
  if (!refusedHooks) {
    for (const site of new Set(unraisedRenderSites(registrations))) {
      findings.push({ level: 'warning', code: 'render-site', message: `its hook on ui.render for ${site} never runs: this surface does not draw ${site}`, file: path })
    }
  }
  const proposed = proposedEventsHooked(registrations)
  if (proposed.length > 0) findings.push({ level: 'note', code: 'proposed-event', message: `it hooks ${proposed.join(', ')}, whose shapes may still change`, file: path })
  for (const hook of module.hooks) {
    if (hook.guards && !hook.hasCatch) {
      findings.push({
        level: 'warning',
        code: 'guard-without-catch',
        message: `its hook on ${hook.event} can refuse an action, and has no .catch: if its own code fails, the action goes through`,
        file: hook.file,
        line: hook.line,
      })
    }
  }
  for (const step of statics.engineSteps) {
    const at = { file: step.file, line: step.line }
    if (step.form === 'other') {
      findings.push({ level: 'error', code: 'engine-create-form', message: 'engine.create is read in one form: const built = await next(e); return { ...built, noun: { … } } — this step cannot be checked', ...at })
    } else if (step.form === 'none') {
      findings.push({ level: 'warning', code: 'engine-create-withholds', message: "engine.create returns without next(e)'s result: it withholds every noun beneath", ...at })
    }
  }
  for (const write of uses.state?.writes ?? []) {
    if (write.plugin === pluginName) continue
    findings.push({ level: 'error', code: 'state-owner', message: `$.state key "${write.key}" belongs to plugin "${write.plugin}": a write from "${pluginName}" is refused`, file: path })
  }
  return { module, uses }
}
