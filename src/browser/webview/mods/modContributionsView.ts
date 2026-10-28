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
  type ContributionIcon,
  type ContributionWelcome,
  type ModContributionsState,
} from '../../runtimeProtocol/modContributions'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import { cn } from '../../../lib/utils'

let state: ModContributionsState = EMPTY_MOD_CONTRIBUTIONS
/** Whether a state has been taken since the last attach: the empty state before one means "unknown". */
let received = false
const listeners = new Set<() => void>()
let modIcon: typeof import('./ModIcon') | null = null
let iconLoad: Promise<void> | null = null
const iconListeners = new Set<() => void>()

/** The icon module, once a state with contributions has loaded it. */
export function loadedModIconModule(): typeof import('./ModIcon') | null {
  return modIcon
}

function subscribeModIconModule(listener: () => void): () => void {
  iconListeners.add(listener)
  return () => iconListeners.delete(listener)
}

/** Load the icon module once; every slot draws its icon when it lands. */
function loadModIconModule(): void {
  if (modIcon || iconLoad) return
  iconLoad = import('./ModIcon').then(
    module => {
      modIcon = module
      for (const listener of [...iconListeners]) listener()
    },
    () => {
      iconLoad = null
    },
  )
}

/**
 * A plugin icon's place: the icon once the module has loaded, before that a
 * blank box with the same classes, so nothing around it moves when it fills.
 */
export function ModIconSlot({
  icon,
  icons,
  className,
}: {
  icon: ContributionIcon | undefined
  icons: Readonly<Record<string, string>>
  className?: string
}): React.ReactElement {
  const module = React.useSyncExternalStore(subscribeModIconModule, loadedModIconModule, loadedModIconModule)
  if (module) return React.createElement(module.ModIcon, { icon, icons, className })
  return React.createElement('span', {
    'aria-hidden': true,
    'data-mod-icon-slot': '',
    className: cn('inline-block shrink-0', className),
  })
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

/** The state once one has been taken, else null: for readers that must not
 *  mistake "nothing yet" for "nothing contributed" (`sessionVisibility.ts`). */
export function getContributionsSnapshot(): ModContributionsState | null {
  return received ? state : null
}

export function subscribeModContributions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Take a new state (the topic, tests). */
export function setModContributions(next: ModContributionsState): void {
  if (next === state && received) return
  state = next
  received = true
  modIcon?.releaseModIconUrls(next.icons)
  for (const listener of [...listeners]) listener()
}

/** Back to nothing known (the topic released, tests). */
export function clearModContributions(): void {
  if (!received && state === EMPTY_MOD_CONTRIBUTIONS) return
  state = EMPTY_MOD_CONTRIBUTIONS
  received = false
  modIcon?.releaseModIconUrls(state.icons)
  for (const listener of [...listeners]) listener()
}

/** Subscribe to the topic on `connection`; returns the release. */
export function attachModContributions(connection: Pick<RuntimeConnection, 'subscribe'>): () => void {
  const unsubscribe = connection.subscribe<ModContributionsState>(MODS_CONTRIBUTIONS_TOPIC, event => {
    const next = event.payload
    if (!isModContributionsState(next)) return
    // Rows are taken at once; their icons fill in when the module has loaded.
    setModContributions(next)
    if (next.templates.length > 0 || next.topbar.length > 0) loadModIconModule()
  })
  return () => {
    unsubscribe()
    clearModContributions()
  }
}

export function useModContributions(): ModContributionsState {
  return React.useSyncExternalStore(subscribeModContributions, getModContributions, getModContributions)
}

export function useContributionsSnapshot(): ModContributionsState | null {
  return React.useSyncExternalStore(subscribeModContributions, getContributionsSnapshot, getContributionsSnapshot)
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
