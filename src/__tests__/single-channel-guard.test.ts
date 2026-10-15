/**
 * One channel between a client and the runtime (F-24): only the four bootstrap handshakes in `boot/` are exempt.
 * Fails when `webview/`, `components/` or `topbar/` touch a raw bridge transport or the legacy WebUI attach, and
 * when an exemption names a file that no longer uses it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..')

/** What a client must not reach for outside the named bootstrap files. */
const FORBIDDEN = [
  {
    token: 'bridge.attachWebUiPort',
    why: 'the legacy WebUI port, deleted in phase 6 — every client attaches with `bridge.attachRuntimePort`',
  },
  {
    token: 'DirectPortBridgeTransport',
    why: "the host's raw C++ port — a client's host calls ride the connection (`hostBridgeOverConnection.ts`)",
  },
  {
    token: 'MessagePortBridgeTransport',
    why: 'a second port to the worker — there is one connection',
  },
] as const

/**
 * `file → tokens it may contain`. A boot file that performs one of the four
 * bootstrap handshakes, and nothing else.
 */
const EXEMPT: Record<string, readonly string[]> = {
  // The `nexus-init` transfer: takes the two C++ ports and gives the worker
  // its own (`bridge.setPort`). The page's own transport over the C++ port is
  // the boot-time catalog read, before a connection exists.
  'browser/boot/nexusBoot.ts': ['DirectPortBridgeTransport'],
}

/**
  * The client side of the app. The worker, the hub and the bridge adapters are
  * the RUNTIME — the direct port is theirs to hold, and this guard is not
  * about them.
  */
const CLIENT_TREES = ['browser/webview', 'components', 'browser/runtimeClient', 'browser/boot']
/** Of those, the trees where no exemption applies at all. */
const NO_EXEMPTION_TREES = ['browser/webview', 'components', 'browser/runtimeClient']

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      walk(full, out)
      continue
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** Comments explain the history; only real code counts as a use. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('one channel to the runtime (R1)', () => {
  const files = CLIENT_TREES.flatMap(tree => walk(join(SRC, tree)))

  it('no client code opens a port of its own', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file).replace(/\\/g, '/')
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const { token, why } of FORBIDDEN) {
        if (!code.includes(token)) continue
        const allowed = EXEMPT[rel]?.includes(token) ?? false
        const noExemption = NO_EXEMPTION_TREES.some(tree => rel.startsWith(`${tree}/`))
        if (allowed && !noExemption) continue
        offenders.push(`${rel} uses ${token} — ${why}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every exemption is still used by the file it names', () => {
    const stale: string[] = []
    for (const [rel, tokens] of Object.entries(EXEMPT)) {
      const code = stripComments(readFileSync(join(SRC, rel), 'utf8'))
      for (const token of tokens) {
        if (!code.includes(token)) stale.push(`${rel} no longer uses ${token} — drop the exemption`)
      }
    }
    expect(stale).toEqual([])
  })
})
