/**
 * The localStorage allowlist (F-24): user data belongs to the runtime; localStorage holds only this client's own
 * layout, disposable caches and identity, each key listed with its reason. Fails on an unlisted use and on a row
 * whose key its file no longer contains.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

type Kind =
  /** How this client lays out or paints its view. Another device lays out its own. */
  | 'view'
  /** A disposable copy of something owned elsewhere; losing it costs a refetch or one empty frame. */
  | 'cache'
  /** Who this client is, or what IT is looking at (per client by definition). */
  | 'client'
  /** A code path the desktop never takes, kept for environments without a host. */
  | 'fallback'
  /** The file only names localStorage in text (a tool description the model reads); it stores nothing. */
  | 'prose'

type Row = { keys: readonly string[]; kind: Kind; why: string }

const ALLOWLIST: Record<string, Row> = {
  'toolkit/builtin/host/browser.ts': {
    keys: [],
    kind: 'prose',
    why: "the BrowserEvaluate tool's description tells the model the page's localStorage is reachable from evaluated code; the file itself stores nothing",
  },
  'browser/boot/guestPalette.ts': {
    keys: ['velloc.appearance.palette', 'velloc.appearance.accent'],
    kind: 'view',
    why: 'which palette this guest paints, and the seed/variant the chrome palette resolves from; needed synchronously before the first paint',
  },
  'browser/boot/guestColorScheme.ts': {
    keys: ['velloc.appearance.colorScheme'],
    kind: 'view',
    why: "this client's light/dark/system choice; per-client so a remote's dark mode never repaints the desktop",
  },
  'browser/boot/appearanceMigration.ts': {
    keys: ['velloc.appearance.migratedFromHostPrefs.v1'],
    kind: 'view',
    why: 'one-shot sentinel: the host-pref theme was copied into this panel already',
  },
  'browser/webview/terminal/terminalPrefs.ts': {
    keys: ['nexus.terminal.prefs'],
    kind: 'view',
    why: "this viewer's cursor style, cursor blink, copy-on-select and scrollback for the Terminal pane; display preferences only, never terminal output",
  },
  'browser/boot/guestTextSize.ts': {
    keys: ['velloc.appearance.textSize'],
    kind: 'view',
    why: 'the type-scale step this guest paints at; needed synchronously before the first paint',
  },
  'browser/webview/showReasoning.ts': {
    keys: ['velloc.appearance.showReasoning'],
    kind: 'view',
    why: "whether THIS client renders the model's reasoning blocks; a view preference — the transcript keeps the reasoning either way",
  },
  'browser/boot/remotePairing.ts': {
    keys: ['nexus.remoteDevicePairing'],
    kind: 'client',
    why: "the pairing a listener link gave THIS device, so the bare address works again later; who this device is to one desktop, re-checked by the runtime on every connection",
  },
  'browser/webview/remote/appInstall.ts': {
    keys: ['nexus.remoteInstallTip'],
    kind: 'view',
    why: "whether THIS browser already dismissed or acted on the install-as-app tip; another device decides for itself",
  },
  'glic/warmSharedWorker.ts': {
    keys: ['nexus.remoteDevicePairing'],
    kind: 'client',
    why: "reads (never writes) remotePairing.ts's key, so a remote boot skips warming a worker it will never use",
  },
  'browser/runtimeClient/sharedWorkerConnection.ts': {
    keys: ['nexus.runtimeClientId'],
    kind: 'client',
    why: "the client id `hello` presents; it identifies this install's client, not the user",
  },
  'browser/webview/bootSessionPointer.ts': {
    keys: ['shift-active-session'],
    kind: 'client',
    why: 'the session THIS client was looking at; two clients look at different ones',
  },
  'browser/webview/layout/layoutStorage.ts': {
    keys: ['nexus.layout', 'nexus.layout.v1'],
    kind: 'view',
    why: "pane layout per session, per-kind pane weights, session card prefs; the retired `nexus.layout.v1` key is named only to remove it",
  },
  'browser/webview/MultiSessionShell.tsx': {
    keys: ['shift-sidebar-width'],
    kind: 'view',
    why: 'sidebar width; the browser pane has no width key of its own (its weight is in the pane layout)',
  },
  'browser/webview/sidebarCollapsedPref.ts': {
    keys: ['shift-sidebar-collapsed'],
    kind: 'view',
    why: 'the sidebar expanded / rail choice, shared by every session and window of this guest',
  },
  'browser/webview/projectsStorage.ts': {
    keys: ['nexus:sidebar:projectsCollapsed'],
    kind: 'view',
    why: "the Projects section's collapsed state (the project LIST is the runtime's `workspace`)",
  },
  'browser/webview/sessionListView.ts': {
    keys: [
      'nexus:sidebar:sessionListView',
      'nexus:sidebar:pinnedCollapsed',
      'nexus:sidebar:recentsCollapsed',
    ],
    kind: 'view',
    why: "how this client groups and orders its session list (group by, sort field, direction), and which of its Pinned / Recents sections are collapsed; another device lists its own way",
  },
  'browser/webview/settings/sections/PluginsSection.tsx': {
    keys: ['nexus.plugins.marketplaceListings.v1'],
    kind: 'cache',
    why: 'marketplace listings shown while the fresh fetch runs',
  },
  'browser/webview/workspaceStore.ts': {
    keys: ['nexus:workspace-cache'],
    kind: 'cache',
    why: 'the last `workspace` state the runtime sent, for a synchronous seed',
  },
  'glic/backgroundCacheUpdate.ts': {
    keys: ['__nexusPrefetchedBuildIds'],
    kind: 'cache',
    why: 'per manifest path, the build whose assets are already prefetched into the HTTP cache',
  },
  'sessions/sessionStore.ts': {
    keys: ['chromium-runtime:conversation'],
    kind: 'fallback',
    why: 'the conversation backend chosen only when no fs-backed one is given; the SharedWorker has no localStorage, so the desktop never reaches it',
  },
}

const SRC = join(__dirname, '..')

/** Source minus comments, so a doc comment mentioning localStorage is not a use. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      sourceFiles(path, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

describe('localStorage allowlist', () => {
  const users = sourceFiles(SRC)
    .filter(path => /\blocalStorage\b/.test(code(readFileSync(path, 'utf8'))))
    .map(path => relative(SRC, path).split('\\').join('/'))
    .sort()

  it('every source file that uses localStorage has a row', () => {
    expect(users.filter(path => !ALLOWLIST[path])).toEqual([])
  })

  it('every row still describes its file', () => {
    const stale: string[] = []
    for (const [path, row] of Object.entries(ALLOWLIST)) {
      if (!users.includes(path)) {
        stale.push(`${path}: no longer uses localStorage — delete the row`)
        continue
      }
      const source = readFileSync(join(SRC, path), 'utf8')
      for (const key of row.keys) {
        if (!source.includes(key)) stale.push(`${path}: key '${key}' is gone`)
      }
      expect(row.why.length).toBeGreaterThan(0)
    }
    expect(stale).toEqual([])
  })

  it('the user data that moved to the runtime stays out of every other file', () => {
    const moved = ['nexus:projects', 'nexus:recent-folders', 'nexus:last-folder-by-type', 'nexus:search:history']
    const offenders = users.filter(path => moved.some(key => readFileSync(join(SRC, path), 'utf8').includes(`'${key}'`)))
    expect(offenders).toEqual([])
  })
})
