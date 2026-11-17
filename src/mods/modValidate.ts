/**
 * VALIDATE (F-25): a static check of a plugin folder, read the way the loader
 * reads it — the manifest and `hooks/hooks.json` through `assemblePluginAt`, each
 * module through the compiler and the scan, the registrations against the
 * admission table. It runs nothing of the mod and is not a security boundary.
 * Security: every path is read through `ModValidateDeps.gate` first; a path the
 * gate refuses, or one past `MOD_VALIDATE_LIMITS`, is not read and is reported.
 * Nothing is written.
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
import { createTranslate } from '../browser/webview/i18n/translate'
import type { MessageKey } from '../browser/webview/i18n/messages/en'

/**
 * `refused`: the loader will not load it. `error`: it loads, but fails where
 * it is used, or cannot be checked here. `warning`: it loads and works, with a
 * risk named. `note`: information.
 */
export type ModValidateLevel = 'refused' | 'error' | 'warning' | 'note'

export type ModValidateFinding = {
  level: ModValidateLevel
  code: string
  /** English, for the model. */
  message: string
  /** The catalog entry `message` renders, when the validator words it; the
   *  loader's and the compiler's reasons have none. */
  detail?: { key: MessageKey; params?: Record<string, string | number> }
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

/** Bounds on what one validation reads: past them a path is reported, not read. */
export const MOD_VALIDATE_LIMITS = Object.freeze({ files: 400, fileBytes: 2 * 1024 * 1024, modules: 64 })

const english = createTranslate('en')

type Said = Pick<ModValidateFinding, 'message' | 'detail'>

/** A finding's text: the English `message` and the catalog entry it renders. */
function said(key: MessageKey, params?: Record<string, string | number>): Said {
  return { message: english(key, params), detail: params ? { key, params } : { key } }
}

/**
 * A read-only view of `fs`. Security: every read passes `gate` first, and a
 * file's content is read only within `MOD_VALIDATE_LIMITS`, once. A path not
 * read lands in `skipped` with the finding that reports it.
 */
function gatedFs(fs: RuntimeFs, gate: (path: string) => Promise<void>, skipped: Map<string, ModValidateFinding>): RuntimeFs {
  let budget = MOD_VALIDATE_LIMITS.files
  const contents = new Map<string, Promise<unknown>>()
  const skip = (path: string, text: Said, code: string): never => {
    skipped.set(path, { level: 'error', code, ...text, file: path })
    throw new GateRefusal(text.message)
  }
  const check = async (path: string): Promise<void> => {
    try {
      await gate(path)
    } catch (error) {
      skip(path, said('slash.out.modValidate.finding.notReadable', { reason: errorText(error) }), 'not-readable')
    }
  }
  const checkContent = async (path: string): Promise<void> => {
    await check(path)
    const { size } = await fs.stat(path)
    if (size > MOD_VALIDATE_LIMITS.fileBytes) {
      skip(path, said('slash.out.modValidate.finding.tooLarge', { bytes: size, limit: MOD_VALIDATE_LIMITS.fileBytes }), 'too-large')
    }
    if (budget <= 0) skip(path, said('slash.out.modValidate.finding.tooManyFiles', { limit: MOD_VALIDATE_LIMITS.files }), 'too-many-files')
    budget -= 1
  }
  const contentReads = new Set(['readFile', 'readFileBytes', 'readRange'])
  const reads = new Set(['stat', 'lstat', 'readdir', 'realpath'])
  return new Proxy(fs, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver) as unknown
      if (typeof value !== 'function' || typeof name !== 'string') return value
      const apply = (path: string, rest: unknown[]): unknown => (value as (...args: unknown[]) => unknown).apply(target, [path, ...rest])
      if (contentReads.has(name)) {
        return (path: string, ...rest: unknown[]) => {
          const id = `${name}\u0000${path}\u0000${JSON.stringify(rest)}`
          let read = contents.get(id)
          if (!read) {
            read = checkContent(path).then(() => apply(path, rest))
            contents.set(id, read)
          }
          return read
        }
      }
      if (reads.has(name)) {
        return async (path: string, ...rest: unknown[]) => {
          await check(path)
          return apply(path, rest)
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
  const skipped = new Map<string, ModValidateFinding>()
  const fs = gatedFs(deps.fs, deps.gate, skipped)
  const report = (plugin: string | null): ModValidateReport => {
    findings.push(...skipped.values())
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
      findings.push({ level: 'refused', code: 'not-a-folder', ...said('slash.out.modValidate.finding.notAFolder'), file: root })
      return report(null)
    }
  } catch (error) {
    if (!(error instanceof GateRefusal)) findings.push({ level: 'refused', code: 'not-a-folder', ...said('slash.out.modValidate.finding.noFolder', { error: errorText(error) }), file: root })
    return report(null)
  }

  const folderName = basenameRuntimePath(root)
  const { plugin, errors } = await assemblePluginAt(root, `validate:${root}`, true, folderName, fs)
  const manifestPath = getPluginManifestPath(root)
  if (!(await fs.stat(manifestPath).then(() => true, () => false))) {
    findings.push({ level: 'warning', code: 'no-manifest', ...said('slash.out.modValidate.finding.noManifest', { name: folderName }), file: manifestPath })
  }
  for (const issue of errors) {
    if (issue.type === 'path-not-found' && skipped.has(issue.path)) continue
    findings.push({ level: 'refused', code: 'manifest', message: describePluginError(issue) })
  }
  const hookModules = plugin.hookModules ?? []
  const providerModules = (plugin.providers ?? []).map(provider => provider.modulePath)
  if (hookModules.length === 0 && providerModules.length === 0) {
    findings.push({
      level: 'note',
      code: 'no-modules',
      ...said('slash.out.modValidate.finding.noModules'),
      file: joinRuntimePath(root, 'hooks', 'hooks.json'),
    })
  }

  let ts: typeof TS | undefined
  const loadTs = async (): Promise<typeof TS> => (ts ??= await (deps.loadTypeScript ?? defaultLoadTypeScript)())
  const ownNouns = new Set<string>()
  const nounCalls: Array<{ noun: string; call: string; module: string }> = []
  const listed = [
    ...hookModules.map(path => [path, 'hooks'] as const),
    ...providerModules.map(path => [path, 'provider'] as const),
  ]
  if (listed.length > MOD_VALIDATE_LIMITS.modules) {
    findings.push({
      level: 'error',
      code: 'too-many-modules',
      ...said('slash.out.modValidate.finding.tooManyModules', { limit: MOD_VALIDATE_LIMITS.modules }),
      file: joinRuntimePath(root, 'hooks', 'hooks.json'),
    })
  }
  for (const [path, kind] of listed.slice(0, MOD_VALIDATE_LIMITS.modules)) {
    const checked = await validateModule(path, kind, root, plugin.name, fs, loadTs, findings, skipped)
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
      ...said('slash.out.modValidate.finding.pluginNoun', { call, noun }),
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
  skipped: Map<string, ModValidateFinding>,
): Promise<{ module: ModValidateModule; uses: ModUses } | null> {
  const refuse = (text: Said, code: string, where: { file?: string; line?: number } = { file: path }): null => {
    findings.push({ level: 'refused', code, ...text, ...where })
    return null
  }
  let source: string
  try {
    source = await fs.readFile(path, { encoding: 'utf-8' })
  } catch (error) {
    if (error instanceof GateRefusal) return null
    return refuse(said('slash.out.modValidate.finding.unreadable', { error: errorText(error) }), 'unreadable')
  }
  const refusedSource = refuseModuleSource(path, source, true)
  if (refusedSource) return refuse({ message: refusedSource }, 'source')
  const ts = await loadTs()
  const before = new Set(skipped.keys())
  let compiled
  try {
    compiled = await compileModModule({ entry: path, root, fs, entrySource: source, loadTypeScript: async () => ts })
  } catch (error) {
    if (error instanceof GateRefusal) return null
    if (error instanceof ModCompileError) {
      const where = {
        ...(error.file !== undefined ? { file: error.file } : { file: path }),
        ...(error.line !== undefined ? { line: error.line } : {}),
      }
      // The compiler takes a refused candidate for a missing one: report the refusal once, at the import.
      const unread = [...skipped.keys()].filter(candidate => !before.has(candidate))
      if (unread.length > 0) {
        const first = skipped.get(unread[0]!)!
        for (const candidate of unread) skipped.delete(candidate)
        const reason = String(first.detail?.params?.reason ?? first.message)
        findings.push({ level: 'error', code: 'import-not-read', ...said('slash.out.modValidate.finding.importNotRead', { reason }), ...where })
        return null
      }
      return refuse({ message: error.message }, 'compile', where)
    }
    return refuse(said('slash.out.modValidate.finding.didNotCompile', { error: errorText(error) }), 'compile')
  }
  let texts: Array<{ path: string; text: string }>
  try {
    texts = await Promise.all(compiled.files.map(async file => ({ path: file, text: file === path ? source : await fs.readFile(file, { encoding: 'utf-8' }) })))
  } catch (error) {
    if (error instanceof GateRefusal) return null
    return refuse(said('slash.out.modValidate.finding.unreadable', { error: errorText(error) }), 'unreadable')
  }
  const statics = readRegistrations(ts, texts)
  const uses = compiled.uses
  for (const unread of statics.unread) {
    findings.push({ level: 'warning', code: 'pattern-not-literal', ...said('slash.out.modValidate.finding.patternNotLiteral'), ...unread })
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
    if (hook.matcherNotObject) findings.push({ level: 'refused', code: 'matcher', ...said('slash.out.modValidate.finding.matcherNotObject', { event: hook.pattern }), ...at })
    if (hook.hasCatch && hook.pattern === 'engine.create') findings.push({ level: 'refused', code: 'catch', ...said('slash.out.modValidate.finding.catchOnEngineCreate'), ...at })
    if (hook.catchFormMismatch) findings.push({ level: 'refused', code: 'catch', ...said('slash.out.modValidate.finding.catchForm', { event: hook.pattern }), ...at })
    if (hook.formUnknown) findings.push({ level: 'note', code: 'hook-form-unknown', ...said('slash.out.modValidate.finding.hookFormUnknown', { event: hook.pattern }), ...at })
  }
  const registrations = asHookRegistrations(statics.hooks)
  if (kind === 'provider') {
    const reason = refuseProviderRegistrations(registrations) ?? refuseProviderModuleUses(uses)
    if (reason) refuse({ message: reason }, 'admission')
    return { module, uses }
  }

  const unsupported = unsupportedEngineCalls(uses, implementedNouns())
  if (unsupported.length > 0) {
    refuse(said('slash.out.modValidate.finding.unsupportedCall', { calls: unsupported.map(call => `$.${call}`).join(', ') }), 'unsupported-call')
  }
  const tentative = registrations.map(hook => hook.pattern).filter(isPluginNounPattern)
  const refusedHooks = refuseRegistrations(registrations, tentative)
  if (refusedHooks) refuse({ message: refusedHooks }, 'unraised-event')
  for (const pattern of tentative) {
    findings.push({ level: 'note', code: 'plugin-noun-event', ...said('slash.out.modValidate.finding.pluginNounEvent', { event: pattern, noun: pattern.slice(0, pattern.indexOf('.')) }), file: path })
  }
  if (!refusedHooks) {
    for (const site of new Set(unraisedRenderSites(registrations))) {
      findings.push({ level: 'warning', code: 'render-site', ...said('slash.out.modValidate.finding.renderSite', { site }), file: path })
    }
  }
  const proposed = proposedEventsHooked(registrations)
  if (proposed.length > 0) findings.push({ level: 'note', code: 'proposed-event', ...said('slash.out.modValidate.finding.proposedEvent', { events: proposed.join(', ') }), file: path })
  for (const hook of module.hooks) {
    if (hook.guards && !hook.hasCatch) {
      findings.push({
        level: 'warning',
        code: 'guard-without-catch',
        ...said('slash.out.modValidate.finding.guardWithoutCatch', { event: hook.event }),
        file: hook.file,
        line: hook.line,
      })
    }
  }
  for (const step of statics.engineSteps) {
    const at = { file: step.file, line: step.line }
    if (step.form === 'other') {
      findings.push({ level: 'error', code: 'engine-create-form', ...said('slash.out.modValidate.finding.engineCreateForm'), ...at })
    } else if (step.form === 'none') {
      findings.push({ level: 'warning', code: 'engine-create-withholds', ...said('slash.out.modValidate.finding.engineCreateWithholds'), ...at })
    }
  }
  for (const write of uses.state?.writes ?? []) {
    if (write.plugin === pluginName) continue
    findings.push({ level: 'error', code: 'state-owner', ...said('slash.out.modValidate.finding.stateOwner', { key: write.key, owner: write.plugin, plugin: pluginName }), file: path })
  }
  return { module, uses }
}
