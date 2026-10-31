/**
 * ADMISSION: what this engine will load, decided before a module's hooks join the
 * chain. A mod must never load and then quietly not work, so an unraised event or an
 * unevaluable module is refused AT LOAD, naming the thing (F-25).
 */

import { CLASSIC_EVENT_NAMES } from './classicEvent'
import { renderMatcherSite } from './modRender'
import { isValidPattern } from './eventPattern'
import { MOD_MODULE_EXTENSIONS, extensionOf, needsCompiler } from './modCompilerSurface'
import { isStreamingEvent, type HookRegistration } from './modTypes'
import type { ModUses } from './modScan'
import {
  PROVIDER_ABI,
  PROVIDER_EVENT_NAMES,
  isProviderPattern,
  refuseProviderModuleCall,
} from './provider/providerEvents'

/** The compatibility level a refusal names. */
export const MODS_ABI = 'Velloc mods ABI 0.2'

/**
 * The events this engine RAISES — the ones a hook registered by name can ever
 * see. Two kinds: the engine's own call sites, and the `$` nouns it serves
 * (a plugin's `$.session.id()` is itself a dispatch other hooks may shape).
 */
export const RAISED_EVENTS: readonly string[] = Object.freeze([
  // engine call sites
  'session.start',
  'session.end',
  'prompt.submit',
  'tool.call',
  'tool.check',
  'command.run',
  // the drawing sites (modRender.ts) and the input they raise
  'ui.render',
  'ui.press',
  'ui.input',
  'ui.select',
  // the turn's boundaries, and each model response between
  // them — a streaming event
  'turn.start',
  'turn.step',
  'turn.complete',
  // a step's whole request before it is sent, the continuation after its
  // tool batch, the retry decision after a failed model call, and the
  // engine's own ids (ABI 0.2)
  'turn.request',
  'turn.continue',
  'turn.recover',
  'ids.next',
  // a module about to join, and the fold that builds `$`
  'plugin.register',
  'engine.create',
  // the system prompt's render (first slice)
  'prompt.section',
  'prompt.compose',
  'prompt.context',
  // each row a conversation keeps, before it is stored
  'session.append',
  // the conversation about to be compacted
  'session.compact',
  // the session's figures after each main-thread turn
  'session.measure',
  // a client joining or leaving the session's roster
  'session.attach',
  'session.detach',
  // a skill's prompt, expanded for the model
  'skill.prompt',
  // the Agent tool: an agent type offered, a subagent about to start
  'agent.offer',
  'agent.spawn',
  // a message leaving for another agent, a delivery reaching the session
  'session.send',
  'session.receive',
  // a tool's description for the model, a command's for the picker
  'tool.describe',
  'command.describe',
  // a `/config` row's label and visibility for the menu and `$.config.list`
  'config.describe',
  // the classic (settings) hooks as events beneath the chain (classicEvent.ts)
  ...CLASSIC_EVENT_NAMES,
  // served `$` nouns (modNouns.ts)
  'session.id',
  'session.cwd',
  'session.root',
  'session.type',
  'session.memoryDir',
  'session.scratchpadDir',
  'session.model',
  'session.turns',
  'session.version',
  'session.surfaces',
  'session.surface',
  'session.repo',
  // answered to a managed install alone (modManagedReads.ts)
  'session.identity',
  'session.messages',
  'session.usage',
  'tool.list',
  'ui.log',
  'ui.status',
  'ui.toast',
  // the `Notification` hooks, then no channel on the desktop (modNotify.ts)
  'ui.notify',
  'ui.view',
  'ui.notice',
  'ui.open',
  'ui.close',
  'ui.panes',
  'ui.invalidate',
  // `$.ui.copy` an op event; `focus` / `scroll` the plugin's own moves of
  // the ring and the window (modPage.ts)
  'ui.copy',
  'ui.focus',
  'ui.scroll',
  // `$.ui.blit`: admitted and raised; the desktop mounts no Raster or
  // Image, so its core answers `{ deny }` (modBlit.ts)
  'ui.blit',
  'turn.abort',
  'clock.now',
  'clock.sleep',
  'clock.after',
  'clock.every',
  'env.get',
  'env.set',
  'settings.read',
  'config.list',
  'config.set',
  'store.get',
  'store.set',
  'store.delete',
  'store.keys',
  'state.get',
  'state.set',
  'command.register',
  'command.list',
  // `$.fs`
  'fs.read',
  'fs.write',
  'fs.list',
  'fs.exists',
  'fs.stat',
  'fs.ancestors',
  'process.run',
  'process.spawn',
  'http.fetch',
  // `$.audio` (modAudio.ts)
  'audio.play',
  'audio.speak',
  'model.complete',
  'model.classify',
  'model.fork',
  'tool.register',
  'agent.register',
  'agent.list',
  'mcp.call',
  'mcp.connect',
  // `$.agent.wait`, and the end of each subagent run (modAgents.ts)
  'agent.wait',
  'agent.complete',
  // `$.script.run` (modScript.ts)
  'script.run',
  // the person's edit in the page's prompt box (modPromptEdit.ts), the rows
  // a mod adds to its typeahead, and its text changing without an edit
  // (promptBoxEvents.ts)
  'prompt.edit',
  'prompt.autocomplete',
  'prompt.change',
  // `$.prompt`'s box: `read` an op event, `fill` / `suggest` the
  // plugin's own calls of their events
  'prompt.read',
  'prompt.fill',
  'prompt.suggest',
  // `$.telemetry`: checked, never sent
  'telemetry.log',
  'telemetry.mark',
])

/**
 * The reason a module's SOURCE cannot be evaluated, or null: an unlisted suffix, or
 * a module that needs the compiler where there is none. The compiler refuses the rest.
 */
export function refuseModuleSource(
  path: string,
  source: string,
  hasCompiler = true,
): string | null {
  const extension = extensionOf(path)
  if (!MOD_MODULE_EXTENSIONS.includes(extension)) {
    return (
      `a hooks module is named .ts, .tsx, .jsx, .js, .mjs, .cjs, .mts or .cts (${MODS_ABI}): ` +
      `"${extension || path}" is not loaded`
    )
  }
  if (!hasCompiler && needsCompiler(path, source)) {
    return (
      `this module needs the TypeScript / JSX compiler (a ${extension} module, or one that imports), ` +
      `which this runtime was not given (${MODS_ABI})`
    )
  }
  return null
}

/**
 * The reason some registered hook can never fire, or null: a name this engine does
 * not raise, a namespace glob with nothing of its form under it, or the wrong FORM
 * (a streaming event needs an `async function*`, any other must not be one).
 */
/** The `ui.render` sites a module names that this surface never draws. */
export function unraisedRenderSites(hooks: readonly HookRegistration[]): string[] {
  const sites: string[] = []
  for (const hook of hooks) {
    if (hook.pattern !== 'ui.render') continue
    const site = renderMatcherSite(hook.matcher)
    if (site.unraised !== undefined) sites.push(site.unraised)
  }
  return sites
}

export function refuseRegistrations(
  hooks: readonly HookRegistration[],
  /** Events raised beside `RAISED_EVENTS` in this slot: the nouns the
   *  plugins loaded before this one added to `$` (`voice.say`), each a `$`
   *  call raised like the engine's own. */
  alsoRaised: readonly string[] = [],
): string | null {
  // A module is one kind, decided by where the manifest lists it: the
  // provider events belong to a module listed under `providers`.
  const providerHooks = [...new Set(hooks.map(hook => hook.pattern).filter(pattern => !pattern.startsWith('!') && isProviderPattern(pattern)))]
  if (providerHooks.length > 0) {
    return (
      `it hooks ${providerHooks.join(', ')}, which only a provider module can hook — ` +
      `list the module under the manifest's providers, not hooks (${PROVIDER_ABI})`
    )
  }
  const raised = alsoRaised.length === 0 ? RAISED_EVENTS : [...RAISED_EVENTS, ...alsoRaised]
  const dead: string[] = []
  const misformed: string[] = []
  for (const hook of hooks) {
    const { pattern } = hook
    const streams = hook.streams === true
    if (!isValidPattern(pattern)) {
      dead.push(pattern)
      continue
    }
    if (pattern.startsWith('!') || pattern === '*') continue
    if (pattern.endsWith('.*')) {
      const namespace = pattern.slice(0, -1)
      if (!raised.some(event => event.startsWith(namespace) && isStreamingEvent(event) === streams)) {
        dead.push(streams ? `${pattern} (as a generator)` : pattern)
      }
      continue
    }
    if (!raised.includes(pattern)) {
      dead.push(pattern)
      continue
    }
    if (isStreamingEvent(pattern) !== streams) {
      misformed.push(pattern)
      continue
    }
    // "A site Velloc has no adapter for is simply not raised, and a mod that
    // hooks only such sites is refused": a `ui.render` matcher
    // naming another component is a hook nothing will ever reach — skipped
    // (`unraisedRenderSites`), the module loading on its other hooks.
  }
  const sites = unraisedRenderSites(hooks)
  if (sites.length > 0 && sites.length === hooks.length) {
    dead.push(...sites.map(site => `ui.render for ${site}`))
  }
  if (misformed.length > 0) {
    const names = [...new Set(misformed)]
    return names
      .map(name =>
        isStreamingEvent(name)
          ? `its hook on ${name} is not an async generator — the one form that loads there (async function* ($, e, next))`
          : `its hook on ${name} is an async generator, which loads only on a streaming event`,
      )
      .join('; ')
  }
  if (dead.length === 0) return null
  const unique = [...new Set(dead)]
  return (
    `it hooks ${unique.length === 1 ? 'an event' : 'events'} this engine does not raise yet: ${unique.join(', ')}`
  )
}

// ── provider modules (Provider Mods) ──

/**
 * Security: the reason a PROVIDER module hooks something it may not, or null. Only
 * provider events, by name or `provider.*`, and no generators: its one worker serves
 * every session and belongs to none.
 */
export function refuseProviderRegistrations(hooks: readonly HookRegistration[]): string | null {
  const foreign: string[] = []
  const unraised: string[] = []
  const generators: string[] = []
  for (const hook of hooks) {
    const { pattern } = hook
    if (pattern === 'provider.*') {
      if (hook.streams === true) generators.push(pattern)
      continue
    }
    if (!isValidPattern(pattern) || !isProviderPattern(pattern) || pattern.startsWith('!')) {
      foreign.push(pattern)
      continue
    }
    if (!(PROVIDER_EVENT_NAMES as readonly string[]).includes(pattern)) {
      unraised.push(pattern)
      continue
    }
    if (hook.streams === true) generators.push(pattern)
  }
  const reasons: string[] = []
  if (foreign.length > 0) {
    reasons.push(
      `a provider module hooks the provider events alone, and it hooks ${[...new Set(foreign)].join(', ')} ` +
        `— put session hooks in a module listed under the manifest's hooks (${PROVIDER_ABI})`,
    )
  }
  if (unraised.length > 0) {
    reasons.push(`it hooks provider events this engine does not raise: ${[...new Set(unraised)].join(', ')} (${PROVIDER_ABI})`)
  }
  if (generators.length > 0) {
    reasons.push(`its hook on ${[...new Set(generators)].join(', ')} is an async generator; the provider events take a plain function`)
  }
  return reasons.length > 0 ? reasons.join('; ') : null
}

/**
 * Whether what a PROVIDER module calls (as scanned before it runs) is what it
 * may call: `$.provider`, `$.store`, `$.http.fetch`, `$.log`, `$.clock` but
 * `every`. Returns the reason it is not, or null. A call the scan cannot see
 * is refused at the call, with the same words.
 */
export function refuseProviderModuleUses(uses: ModUses): string | null {
  const reasons: string[] = []
  for (const call of uses.calls) {
    const dot = call.indexOf('.')
    const reason = refuseProviderModuleCall(dot === -1 ? call : call.slice(0, dot), dot === -1 ? '' : call.slice(dot + 1))
    if (reason && !reasons.includes(reason)) reasons.push(reason)
  }
  return reasons.length > 0 ? reasons.join('; ') : null
}
