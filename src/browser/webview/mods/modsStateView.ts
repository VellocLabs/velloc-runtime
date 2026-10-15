/**
 * The client's read of `mods/state` — what became of every session's mods
 * (hooks modules), one shared subscription per connection (F-25).
 *
 * The same shape as `remote/remoteAccessView.ts`: the topic's snapshot goes to
 * the FIRST listener only, so one store per connection holds the latest
 * payload and fans it out; the last listener releases the subscription.
 */
import * as React from 'react'

import {
  MODS_STATE_TOPIC,
  isModsStatePayload,
  type ModStateRow,
  type ModsStatePayload,
} from '../../runtimeProtocol'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'

export type ModsStateView = ModsStatePayload

type Listener = (view: ModsStateView) => void

type Store = {
  latest: ModsStateView | null
  listeners: Set<Listener>
  unsubscribe: (() => void) | null
}

const stores = new WeakMap<Pick<RuntimeConnection, 'subscribe'>, Store>()

export function holdModsStateView(
  connection: Pick<RuntimeConnection, 'subscribe'>,
  listener: Listener,
): () => void {
  let store = stores.get(connection)
  if (!store) {
    store = { latest: null, listeners: new Set(), unsubscribe: null }
    stores.set(connection, store)
  }
  const held = store
  held.listeners.add(listener)
  if (held.unsubscribe === null) {
    held.unsubscribe = connection.subscribe<ModsStatePayload>(MODS_STATE_TOPIC, event => {
      if (!isModsStatePayload(event.payload)) return
      held.latest = event.payload
      for (const each of Array.from(held.listeners)) each(held.latest)
    })
  } else if (held.latest) {
    listener(held.latest)
  }
  return () => {
    if (!held.listeners.delete(listener)) return
    if (held.listeners.size > 0) return
    held.unsubscribe?.()
    held.unsubscribe = null
    held.latest = null
  }
}

export function useModsStateView(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  enabled = true,
): ModsStateView | null {
  const [view, setView] = React.useState<ModsStateView | null>(null)
  React.useEffect(() => {
    if (!runtimeConnection || !enabled) {
      setView(null)
      return
    }
    let live = true
    let release: (() => void) | null = null
    void runtimeConnection().then(
      conn => {
        if (!live) return
        release = holdModsStateView(conn, next => {
          if (live) setView(next)
        })
      },
      () => {
        // No connection → no view; the page shows nothing about mods.
      },
    )
    return () => {
      live = false
      release?.()
    }
  }, [runtimeConnection, enabled])
  return view
}

/** One plugin's mods across every session: the rows, by module path. */
export type ModPluginSummary = {
  plugin: string
  /** Every (session, module) row, newest state per module per session. */
  rows: Array<ModStateRow & { sessionId: string }>
  /** How many sessions have at least one of its modules loaded. */
  loadedSessions: number
  /** The one state to show: the worst of its rows (`dead` > `refused` >
   *  `failed` > `crashed` > `loaded`), and that row's reason. */
  worst: ModStateRow['state']
  reason?: string
  /** Who the plugin is, from the first row that says (Settings → Plugins &
   *  Mods): the manifest's version and description, where it came from
   *  (`<name>@<marketplace>`, `<name>@inline`, `<name>@builtin`), its
   *  directory and its tier. */
  version?: string
  description?: string
  provenance?: string
  root?: string
  tier?: ModStateRow['tier']
  /** Every event pattern any of its modules hooks, deduplicated. */
  events: string[]
}

/** A mod a person installed (not a bundled or managed one) — may be
 *  uninstalled. An older runtime names no tier: `user` — unless the row's
 *  provenance says it ships with the product (`<name>@builtin`,
 *  `mods/builtinMods.ts`): a built-in is never offered for uninstall, whatever
 *  tier a runtime reports. */
export function isUserMod(summary: ModPluginSummary): boolean {
  if (summary.provenance?.endsWith('@builtin')) return false
  return (summary.tier ?? 'user') === 'user'
}

/** A directory plugin (`<name>@inline`, or a row naming no provenance). */
export function isLocalMod(summary: ModPluginSummary): boolean {
  return summary.provenance === undefined || summary.provenance.endsWith('@inline')
}

const SEVERITY: Record<ModStateRow['state'], number> = {
  loaded: 0,
  crashed: 1,
  failed: 2,
  refused: 3,
  dead: 4,
}

/** The view folded per plugin, in first-seen order. */
export function summarizeModsByPlugin(view: ModsStateView | null): ModPluginSummary[] {
  if (!view) return []
  const byPlugin = new Map<string, ModPluginSummary>()
  for (const session of view.sessions) {
    const loadedHere = new Set<string>()
    for (const row of session.mods) {
      let summary = byPlugin.get(row.plugin)
      if (!summary) {
        summary = { plugin: row.plugin, rows: [], loadedSessions: 0, worst: 'loaded', events: [] }
        byPlugin.set(row.plugin, summary)
      }
      summary.rows.push({ ...row, sessionId: session.sessionId })
      for (const field of ['version', 'description', 'provenance', 'root', 'tier'] as const) {
        if (summary[field] === undefined && row[field] !== undefined) {
          ;(summary as Record<typeof field, unknown>)[field] = row[field]
        }
      }
      for (const event of row.events ?? []) {
        if (!summary.events.includes(event)) summary.events.push(event)
      }
      if (row.state === 'loaded') loadedHere.add(row.plugin)
      if (SEVERITY[row.state] > SEVERITY[summary.worst]) {
        summary.worst = row.state
        if (row.reason !== undefined) summary.reason = row.reason
        else delete summary.reason
      }
    }
    for (const plugin of loadedHere) {
      const summary = byPlugin.get(plugin)
      if (summary) summary.loadedSessions += 1
    }
  }
  return [...byPlugin.values()]
}
