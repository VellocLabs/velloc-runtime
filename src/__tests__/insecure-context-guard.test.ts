/**
 * The client runs off a secure context (F-24): on the remote client's plain-http page `crypto.randomUUID`,
 * `crypto.subtle`, `navigator.clipboard`, `Notification` and Service Worker are absent, so the client trees go
 * through `utils/randomUuid.ts` and `utils/clipboard.ts` (outside the scanned trees). Worker trees are not
 * scanned: the runtime always runs in the https desktop guest. Comments are stripped before matching.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..')

/** Gated on a secure context — absent on `http://<IP>`, so a direct call throws. */
const FORBIDDEN = [
  {
    token: 'crypto.randomUUID',
    why: 'absent off a secure context — call `randomUuid()` from `utils/randomUuid.ts`',
  },
  {
    token: 'crypto.subtle',
    why: 'absent off a secure context — the pair proof is pure JS (`runtimeProtocol/pairProof.ts`)',
  },
  {
    token: 'navigator.clipboard',
    why: 'absent off a secure context — use `writeClipboard` / `readClipboard` from `utils/clipboard.ts`',
  },
  {
    token: 'navigator.serviceWorker',
    why: 'absent off a secure context — the client must not depend on a Service Worker',
  },
] as const

/**
 * The client half of the app: everything the remote page loads and runs. The
 * SharedWorker (`browser/worker`, `browser/runtimeHub`) is the RUNTIME and
 * always https — not scanned.
 */
const CLIENT_TREES = [
  'browser/webview',
  'components',
  'browser/runtimeClient',
  'browser/boot',
  'glic',
]

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

describe('the client runs off a secure context', () => {
  const trees = CLIENT_TREES.map(tree => join(SRC, tree)).filter(dir => existsSync(dir))
  const files = trees.flatMap(dir => walk(dir))

  it('scans every client tree', () => {
    // A renamed or deleted tree must fail loudly rather than silently
    // scanning nothing — that is how a guard rots.
    expect(trees).toHaveLength(CLIENT_TREES.length)
    expect(files.length).toBeGreaterThan(0)
  })

  it('no client code calls a secure-context-only API', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file).replace(/\\/g, '/')
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const { token, why } of FORBIDDEN) {
        if (code.includes(token)) offenders.push(`${rel} uses ${token} — ${why}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the two exemptions live outside the scanned trees', () => {
    // `utils/randomUuid.ts` and `utils/clipboard.ts` are allowed to touch the
    // gated globals because they are the fallbacks. If either were ever moved
    // INTO a client tree the guard above would start failing on it, and
    // someone would "fix" it by adding an exemption list. Pin the location.
    for (const rel of ['utils/randomUuid.ts', 'utils/clipboard.ts']) {
      expect(existsSync(join(SRC, rel))).toBe(true)
      expect(CLIENT_TREES.some(tree => rel.startsWith(`${tree}/`))).toBe(false)
    }
  })
})
