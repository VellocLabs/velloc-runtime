/**
 * Session hook registry on `WorkingState.sessionHooks`
 * (`Map<sessionId, { hooks: { [event]: matchers[] } }>`); a Map keeps container
 * identity across mutations.
 */

import type { WorkingState } from '../runtime/RuntimeTypes'
import {
  LIFECYCLE_EVENT_NAMES,
  type AnyHook,
  type InProcessHookSpec,
  type HookCommand,
  type LifecycleEventName,
  sameHookSpec,
} from './hookTypes'

type SessionHookEntry = {
  hook: AnyHook
  /** Optional skill root the hook was registered under. */
  skillRoot?: string
}

type TransientHookEntry = {
  matcher: string
  skillRoot?: string
  hooks: SessionHookEntry[]
}

export type SessionHookStore = {
  hooks: Partial<Record<LifecycleEventName, TransientHookEntry[]>>
}

type WorkingStateWriter = (updater: (prev: WorkingState) => WorkingState) => void

function getStore(appState: WorkingState, sessionId: string): SessionHookStore | undefined {
  return appState.sessionHooks?.get(sessionId)
}

function ensureMap(prev: WorkingState): Map<string, SessionHookStore> {
  if (prev.sessionHooks) {
    return prev.sessionHooks
  }
  // Lazily initialize on first registration so the Map allocation only
  // shows up on sessions that actually use hooks.
  const map = new Map<string, SessionHookStore>()
  prev.sessionHooks = map
  return map
}

/**
 * Add a persistable command hook for a session. The hook is held in
 * memory only.
 */
export function attachTransientHook(
  setAppState: WorkingStateWriter,
  sessionId: string,
  event: LifecycleEventName,
  matcher: string,
  hook: HookCommand,
  options: { skillRoot?: string } = {},
): void {
  addAny(setAppState, sessionId, event, matcher, hook, options.skillRoot)
}

/**
 * Add an in-memory function hook for a session. Returns the hook id so
 * `detachInProcessHook` can target it without callers carrying the
 * callback closure around.
 */
export function attachInProcessHook(
  setAppState: WorkingStateWriter,
  sessionId: string,
  event: LifecycleEventName,
  matcher: string,
  callback: InProcessHookSpec['callback'],
  errorMessage: string,
  options: { timeout?: number; id?: string; skillRoot?: string } = {},
): string {
  const id =
    options.id ??
    `function-hook-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const hook: InProcessHookSpec = {
    type: 'function',
    id,
    timeout: options.timeout ?? 5000,
    callback,
    errorMessage,
  }
  addAny(setAppState, sessionId, event, matcher, hook, options.skillRoot)
  return id
}

function addAny(
  setAppState: WorkingStateWriter,
  sessionId: string,
  event: LifecycleEventName,
  matcher: string,
  hook: AnyHook,
  skillRoot: string | undefined,
): void {
  setAppState(prev => {
    const map = ensureMap(prev)
    const store: SessionHookStore = map.get(sessionId) ?? { hooks: {} }
    const matchers = store.hooks[event] ?? []
    const existingIndex = matchers.findIndex(
      m => m.matcher === matcher && m.skillRoot === skillRoot,
    )
    let nextMatchers: TransientHookEntry[]
    if (existingIndex >= 0) {
      nextMatchers = matchers.slice()
      const existing = nextMatchers[existingIndex]!
      nextMatchers[existingIndex] = {
        matcher: existing.matcher,
        skillRoot: existing.skillRoot,
        hooks: [...existing.hooks, { hook, skillRoot }],
      }
    } else {
      nextMatchers = [
        ...matchers,
        { matcher, skillRoot, hooks: [{ hook, skillRoot }] },
      ]
    }
    map.set(sessionId, {
      hooks: { ...store.hooks, [event]: nextMatchers },
    })
    // Return prev with the mutated Map — Object.is(prev, prev) is true,
    // so any AppState-listening store short-circuits its diff check.
    return prev
  })
}

export function detachTransientHook(
  setAppState: WorkingStateWriter,
  sessionId: string,
  event: LifecycleEventName,
  hook: AnyHook,
): void {
  setAppState(prev => {
    const store = getStore(prev, sessionId)
    if (!store) {
      return prev
    }
    const matchers = store.hooks[event]
    if (!matchers || matchers.length === 0) {
      return prev
    }
    const next: TransientHookEntry[] = []
    for (const m of matchers) {
      const remaining = m.hooks.filter(h => !sameHookSpec(h.hook, hook))
      if (remaining.length > 0) {
        next.push({ matcher: m.matcher, skillRoot: m.skillRoot, hooks: remaining })
      }
    }
    const nextHooks = { ...store.hooks }
    if (next.length === 0) {
      delete nextHooks[event]
    } else {
      nextHooks[event] = next
    }
    prev.sessionHooks!.set(sessionId, { hooks: nextHooks })
    return prev
  })
}

export function detachInProcessHook(
  setAppState: WorkingStateWriter,
  sessionId: string,
  event: LifecycleEventName,
  hookId: string,
): void {
  setAppState(prev => {
    const store = getStore(prev, sessionId)
    if (!store) {
      return prev
    }
    const matchers = store.hooks[event]
    if (!matchers || matchers.length === 0) {
      return prev
    }
    const next: TransientHookEntry[] = []
    for (const m of matchers) {
      const remaining = m.hooks.filter(h => {
        if (h.hook.type !== 'function') return true
        return h.hook.id !== hookId
      })
      if (remaining.length > 0) {
        next.push({ matcher: m.matcher, skillRoot: m.skillRoot, hooks: remaining })
      }
    }
    const nextHooks = { ...store.hooks }
    if (next.length === 0) {
      delete nextHooks[event]
    } else {
      nextHooks[event] = next
    }
    prev.sessionHooks!.set(sessionId, { hooks: nextHooks })
    return prev
  })
}

/**
 * Remove every matcher registered under `skillRoot` for a session, across all
 * events. Used when a plugin is disabled / reloaded to drop only that plugin's
 * hooks (each plugin's matchers carry its path as `skillRoot`) without
 * touching function hooks or other plugins' hooks.
 */
export function removeSessionHooksBySkillRoot(
  setAppState: WorkingStateWriter,
  sessionId: string,
  skillRoot: string,
): void {
  setAppState(prev => {
    const store = getStore(prev, sessionId)
    if (!store) {
      return prev
    }
    const nextHooks: Partial<Record<LifecycleEventName, TransientHookEntry[]>> = {}
    for (const [event, matchers] of Object.entries(store.hooks) as [
      LifecycleEventName,
      TransientHookEntry[],
    ][]) {
      const kept = matchers.filter(matcher => matcher.skillRoot !== skillRoot)
      if (kept.length > 0) {
        nextHooks[event] = kept
      }
    }
    prev.sessionHooks!.set(sessionId, { hooks: nextHooks })
    return prev
  })
}

/** Clear all session hooks for `sessionId` — called on session end. */
export function dropTransientHooks(
  setAppState: WorkingStateWriter,
  sessionId: string,
): void {
  setAppState(prev => {
    if (!prev.sessionHooks) {
      return prev
    }
    prev.sessionHooks.delete(sessionId)
    return prev
  })
}

export type TransientHookView = {
  matcher: string
  skillRoot?: string
  hooks: HookCommand[]
}

/**
 * Read persistable hooks for a session (excludes in-memory function
 * hooks — those are returned by `inProcessHooksFor`). Returns
 * an empty Map if the session has no registrations, so callers don't
 * need to null-check.
 */
export function transientHooksFor(
  appState: WorkingState,
  sessionId: string,
  event?: LifecycleEventName,
): Map<LifecycleEventName, TransientHookView[]> {
  const store = getStore(appState, sessionId)
  const out = new Map<LifecycleEventName, TransientHookView[]>()
  if (!store) {
    return out
  }
  const events = event ? [event] : LIFECYCLE_EVENT_NAMES
  for (const evt of events) {
    const matchers = store.hooks[evt]
    if (!matchers) continue
    const derived: TransientHookView[] = []
    for (const m of matchers) {
      const hooks = m.hooks
        .map(h => h.hook)
        .filter((h): h is HookCommand => h.type !== 'function')
      if (hooks.length > 0) {
        const entry: TransientHookView = { matcher: m.matcher, hooks }
        if (m.skillRoot !== undefined) {
          entry.skillRoot = m.skillRoot
        }
        derived.push(entry)
      }
    }
    if (derived.length > 0) {
      out.set(evt, derived)
    }
  }
  return out
}

export type SessionFunctionHookMatcher = {
  matcher: string
  skillRoot?: string
  hooks: InProcessHookSpec[]
}

/** Read in-memory function hooks for a session. Separate accessor
 *  from `transientHooksFor` because function callbacks can't be
 *  serialized into the HookCommand wire shape. */
export function inProcessHooksFor(
  appState: WorkingState,
  sessionId: string,
  event?: LifecycleEventName,
): Map<LifecycleEventName, SessionFunctionHookMatcher[]> {
  const store = getStore(appState, sessionId)
  const out = new Map<LifecycleEventName, SessionFunctionHookMatcher[]>()
  if (!store) {
    return out
  }
  const events = event ? [event] : LIFECYCLE_EVENT_NAMES
  for (const evt of events) {
    const matchers = store.hooks[evt]
    if (!matchers) continue
    const derived: SessionFunctionHookMatcher[] = []
    for (const m of matchers) {
      const hooks = m.hooks
        .map(h => h.hook)
        .filter((h): h is InProcessHookSpec => h.type === 'function')
      if (hooks.length > 0) {
        const entry: SessionFunctionHookMatcher = { matcher: m.matcher, hooks }
        if (m.skillRoot !== undefined) {
          entry.skillRoot = m.skillRoot
        }
        derived.push(entry)
      }
    }
    if (derived.length > 0) {
      out.set(evt, derived)
    }
  }
  return out
}
