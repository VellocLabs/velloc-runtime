/**
 * The page's read of `mods/contributions` (F-25): the launchers and topbar
 * items of the person's plugins. One realm-wide store, attached once to the
 * runtime connection; every reader shares it through `useModContributions`.
 * Until the first snapshot it holds nothing, so the bundled launchers paint
 * without waiting for it.
 */
import * as React from 'react'

import {
  EMPTY_MOD_CONTRIBUTIONS,
  MODS_CONTRIBUTIONS_TOPIC,
  type ContributionWelcome,
  type ModContributionsState,
} from '../../runtimeProtocol/modContributions'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'

let state: ModContributionsState = EMPTY_MOD_CONTRIBUTIONS
const listeners = new Set<() => void>()
let modIcon: typeof import('./ModIcon') | null = null
let delivered = 0

/** The icon module, once a state with contributions has loaded it. */
export function loadedModIconModule(): typeof import('./ModIcon') | null {
  return modIcon
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether `value` has the topic's shape; the fields' own shapes are trusted. */
export function isModContributionsState(value: unknown): value is ModContributionsState {
  return (
    isRecord(value) &&
    Array.isArray(value.templates) &&
    Array.isArray(value.topbar) &&
    isRecord(value.icons) &&
    Array.isArray(value.waiting)
  )
}

export function getModContributions(): ModContributionsState {
  return state
}

export function subscribeModContributions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Take a new state (the topic, tests). */
export function setModContributions(next: ModContributionsState): void {
  if (next === state) return
  state = next
  modIcon?.releaseModIconUrls(next.icons)
  for (const listener of [...listeners]) listener()
}

/** Subscribe to the topic on `connection`; returns the release. */
export function attachModContributions(connection: Pick<RuntimeConnection, 'subscribe'>): () => void {
  const unsubscribe = connection.subscribe<ModContributionsState>(MODS_CONTRIBUTIONS_TOPIC, event => {
    const next = event.payload
    if (!isModContributionsState(next)) return
    const seq = ++delivered
    const take = (): void => {
      if (seq === delivered) setModContributions(next)
    }
    // The icon module loads with the first contribution, before it is shown,
    // so no launcher draws a placeholder first.
    if (modIcon || (next.templates.length === 0 && next.topbar.length === 0)) take()
    else {
      void import('./ModIcon').then(
        module => {
          modIcon = module
          take()
        },
        take,
      )
    }
  })
  return () => {
    unsubscribe()
    setModContributions(EMPTY_MOD_CONTRIBUTIONS)
  }
}

export function useModContributions(): ModContributionsState {
  return React.useSyncExternalStore(subscribeModContributions, getModContributions, getModContributions)
}

/** Attach the store for as long as the shell holds a connection that may read it. */
export function useAttachModContributions(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
): void {
  React.useEffect(() => {
    if (!runtimeConnection) return
    let live = true
    let release: (() => void) | null = null
    void runtimeConnection().then(
      conn => {
        if (!live || !conn.can('mods', 'contributions')) return
        release = attachModContributions(conn)
      },
      () => {
        // No connection: no plugin launchers or topbar items.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection])
}

/** A plugin template's welcome page for `locale` ('' = its default file). */
export function pluginWelcome(
  state: ModContributionsState,
  type: string,
  locale: string,
): ContributionWelcome | undefined {
  const pages = state.templates.find(template => template.type === type)?.welcome
  if (!pages) return undefined
  const wanted = locale.toLowerCase().replace(/_/g, '-')
  const keys = Object.keys(pages)
  const exact = keys.find(key => key.toLowerCase().replace(/_/g, '-') === wanted)
  const language = keys.find(key => key !== '' && key.toLowerCase().split(/[-_]/)[0] === wanted.split('-')[0])
  return pages[exact ?? language ?? ''] ?? undefined
}
