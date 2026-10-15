import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Type-only (erased at runtime) so `vi.resetModules()` still gives each
// case a fresh utils module instance.
import type { WebFetchDeps } from '../toolkit/builtin/webFetch/fetchHelpers'

/**
 * WebFetch guards: `network.httpGet` route policy stitches the body bytes; Turndown runs without window/document;
 * WebFetch passes max_body_size <= 50 MB to network.httpGet.
 */

describe('WebFetch — regression guards', () => {
  // ---------------------------------------------------------------------------
  // Bug #1: bridge route-policy must declare `body` as a binary field for
  //         `network.httpGet`, otherwise the transferred port is dropped and
  //         `result.body` arrives as `undefined`.
  // ---------------------------------------------------------------------------
  describe('route-policy stitches body bytes', () => {
    it('declares network.httpGet with resultBinaryFields=["body"]', async () => {
      // Import lazily because the module captures module-private state at
      // first import; we want the fresh module to see whatever the prod
      // file currently exports.
      const mod = (await import(
        '../browser/bridge/DirectPortBridgeTransport'
      )) as unknown as {
        // Test-only re-export: the policy table is module-private in prod,
        // so this test references the surrounding behaviour rather than the
        // table directly. If a future refactor wants to make the table
        // public for tests, we'd swap to a direct equality check here.
        __test_only_directPortRoutePolicy?: Record<
          string,
          Record<string, { mode?: string; resultBinaryFields?: string[] }>
        >
      }
      const table = mod.__test_only_directPortRoutePolicy

      // If the test-only export isn't there, document why and fall back to
      // a structural-shape check via the public route declaration. The
      // shape we care about is: there exists a `network.httpGet` entry in
      // the prod policy whose resultBinaryFields is exactly `['body']`.
      if (table) {
        const entry = table.network?.httpGet
        expect(entry, 'network.httpGet must have a route-policy entry').toBeDefined()
        expect(entry?.mode).toBe('response_port')
        expect(entry?.resultBinaryFields).toEqual(['body'])
      } else {
        // Test-only export hasn't been added yet — the test still asserts
        // the file contains the right code by string-scanning. Cheap
        // safety net until the export lands. The check is anchored on the
        // unique substring of the route entry the bug taught us must be
        // present.
        const fs = await import('node:fs/promises')
        const path = await import('node:path')
        const here = path.dirname(new URL(import.meta.url).pathname)
        const src = await fs.readFile(
          path.resolve(here, '../browser/bridge/DirectPortBridgeTransport.ts'),
          'utf8',
        )
        expect(
          src,
          'network.httpGet must have resultBinaryFields=["body"] — without ' +
            'this the C++ side\'s body-port arrives but the transport drops ' +
            'it on the floor and `result.body` is undefined at the call site',
        ).toMatch(/httpGet:\s*{[^}]*resultBinaryFields:\s*\[\s*'body'\s*\]/)
        expect(src).toMatch(/httpGet:\s*{[^}]*mode:\s*'response_port'/)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // HTML → markdown (`PageReadTool/utils.ts`) in a window-less, document-less env, parsed through
  // `@mixmark-io/domino`.
  // ---------------------------------------------------------------------------
  describe('Turndown runs in node-env without window/document', () => {
    beforeEach(() => {
      // Force-remove any vestigial polyfills the test harness installed.
      // Vitest's "node" environment doesn't set these, but other tests in
      // the same file may have leaked them via globalThis.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).window
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).document
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).DOMParser
    })

    afterEach(() => {
      vi.resetModules()
    })

    it('domino parses HTML and Turndown accepts the parsed Document', async () => {
      // Confirm the environment matches what nexus_web's SharedWorker sees.
      expect(
        typeof globalThis === 'object' && !('window' in globalThis),
        'precondition: this test must run in a node-env (no window)',
      ).toBe(true)
      expect(
        typeof (globalThis as { document?: unknown }).document,
        'precondition: no document either',
      ).toBe('undefined')

      const utils = await import('../toolkit/builtin/webFetch/fetchHelpers')

      // Pull the private helper through a Vitest dynamic import. The
      // `parseHtmlInWorker` symbol isn't exported from utils.ts, so we
      // exercise the public surface that uses it (`capturePageAsMarkdown`)
      // by stubbing the network operations and triggering the HTML→MD
      // path. The fact that this returns without throwing is the assertion.
      const stubBody = new TextEncoder().encode(
        '<!doctype html><html><body>' +
          '<h1>Title</h1>' +
          '<p>Lead paragraph with <a href="/spec">a link</a>.</p>' +
          '<pre><code>console.log("hi")</code></pre>' +
          '</body></html>',
      )

      const deps: WebFetchDeps = {
        network: {
          httpGet: async () => ({
            status: 200,
            statusText: 'OK',
            finalUrl: 'https://example.test/',
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: stubBody,
          }),
        },
        runtimeCwd: '/tmp/nexus-test',
      }

      // Bust the in-module URL_CACHE before the call so a previous test
      // run doesn't shadow the actual HTML→MD pass.
      utils.forgetFetchedPages()

      const result = await utils.capturePageAsMarkdown(
        'https://example.test/',
        new AbortController(),
        deps,
      )

      // Must be the PageCapture branch (not a redirect).
      expect('type' in result && result.type === 'redirect').toBe(false)
      if ('type' in result) return // narrows for TS, never taken at runtime

      // The headline gets through Turndown into markdown.
      expect(result.content).toContain('Title')
      // The link survives as markdown.
      expect(result.content.toLowerCase()).toMatch(/\[a link\]\(\/spec\)/)
      // Sanity check: no raw `<` from un-stripped HTML (i.e. Turndown ran).
      expect(result.content).not.toContain('<h1>')

      // Restore state so subsequent tests in this file get a fresh cache.
      utils.forgetFetchedPages()
    })
  })

  // ---------------------------------------------------------------------------
  // The maxResponseBytes cap passed to `httpGet`, observed over a stubbed network.
  // ---------------------------------------------------------------------------
  describe('WebFetch passes max_body_size <= 50 MB to network.httpGet', () => {
    afterEach(() => {
      vi.resetModules()
    })

    it('forwards a 50 MB (or smaller) cap on every fetch', async () => {
      const utils = await import('../toolkit/builtin/webFetch/fetchHelpers')

      let observedMaxResponseBytes: number | undefined
      const deps: WebFetchDeps = {
        network: {
          httpGet: async (_url: string, options?: { maxResponseBytes?: number }) => {
            observedMaxResponseBytes = options?.maxResponseBytes
            return {
              status: 200,
              statusText: 'OK',
              finalUrl: 'https://example.test/',
              headers: { 'content-type': 'text/plain' },
              body: new Uint8Array(0),
            }
          },
        },
        runtimeCwd: '/tmp/nexus-test',
      }

      utils.forgetFetchedPages()
      await utils.capturePageAsMarkdown(
        'https://example.test/',
        new AbortController(),
        deps,
      )

      // V2 ceiling: C++ host uses
      // `DownloadToStringOfUnboundedSizeUntilCrashAndDie` with an
      // explicit 50 MB cap enforced by OnResponseStarted +
      // OnDownloadProgress callbacks. Anything > 50 MB will be
      // refused by the C++ side (RESPONSE_TOO_LARGE error). The TS
      // side should never ask for more than this either.
      const FIFTY_MB = 50 * 1024 * 1024
      expect(
        observedMaxResponseBytes,
        'WebFetch must pass an explicit maxResponseBytes so the cap is ' +
          'visible at the call site, not inferred from the C++ default',
      ).toBeDefined()
      expect(
        observedMaxResponseBytes ?? 0,
        'maxResponseBytes must be <= V2 ceiling of 50 MB ' +
          `(${FIFTY_MB} bytes). Above that, the C++ side aborts with ` +
          'RESPONSE_TOO_LARGE.',
      ).toBeLessThanOrEqual(FIFTY_MB)

      utils.forgetFetchedPages()
    })
  })

  // ---------------------------------------------------------------------------
  // V2 feature: text-overflow disk persistence. When the post-Turndown
  // markdown exceeds PAGE_TEXT_CHAR_CAP (100K chars), the full markdown
  // is persisted to disk and the tool result tells the outer model where
  // to find it. This test pins that Nexus does NOT lossy-truncate here.
  // ---------------------------------------------------------------------------
  describe('text-overflow disk persistence (V2)', () => {
    afterEach(() => {
      vi.resetModules()
    })

    it('persists full markdown to disk when content exceeds PAGE_TEXT_CHAR_CAP', async () => {
      const utils = await import('../toolkit/builtin/webFetch/fetchHelpers')

      // Build an HTML body whose Turndown output will be > 100K
      // chars. Repeated paragraphs of plain text are the most
      // reliable way — Turndown preserves them 1:1 with minimal
      // markdown overhead.
      const paragraph =
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
        'Sed do eiusmod tempor incididunt ut labore et dolore magna ' +
        'aliqua. Ut enim ad minim veniam, quis nostrud exercitation ' +
        'ullamco laboris nisi ut aliquip ex ea commodo consequat.\n'
      // ~250 chars per paragraph × 500 = ~125K chars HTML, ~120K
      // chars markdown after Turndown — comfortably above the 100K
      // threshold.
      const longHtml =
        '<!doctype html><html><body>' +
        Array.from({ length: 500 })
          .map((_, i) => `<p>Section ${i}. ${paragraph}</p>`)
          .join('') +
        '</body></html>'

      // Track fs writes via a stub FS implementation.
      const fsWrites: Array<{ path: string; size: number }> = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stubFs: any = {
        async mkdir() {
          /* allow */
        },
        async writeFile(path: string, content: Uint8Array | string) {
          const bytes =
            typeof content === 'string'
              ? new TextEncoder().encode(content)
              : content
          fsWrites.push({ path, size: bytes.byteLength })
        },
      }
      const fsOps = await import('../utils/fs/runtimeFs')
      fsOps.installProcessFs(stubFs)

      const deps: WebFetchDeps = {
        network: {
          httpGet: async () => ({
            status: 200,
            statusText: 'OK',
            finalUrl: 'https://example.test/big',
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: new TextEncoder().encode(longHtml),
          }),
        },
        runtimeCwd: '/tmp/nexus-test',
      }

      utils.forgetFetchedPages()
      const result = await utils.capturePageAsMarkdown(
        'https://example.test/big',
        new AbortController(),
        deps,
      )

      expect('type' in result && result.type === 'redirect').toBe(false)
      if ('type' in result) return

      // Sanity: the markdown is actually over the threshold.
      expect(result.content.length).toBeGreaterThan(100_000)

      // The full markdown must be on disk. Match by path shape:
      // `<runtimeCwd>/webfetch/webfetch-<ts>-<rand>.md`. The
      // `webfetch/` parent is relative to the model's workspace
      // (resolvedProjectRoot) so Glob/Read can find it from cwd.
      const markdownWrite = fsWrites.find((w) =>
        /[/\\]webfetch[/\\]webfetch-\d+-[a-z0-9]+\.md$/.test(w.path),
      )
      expect(
        markdownWrite,
        'V2 text-overflow disk persistence must write a .md file to ' +
          '<runtimeCwd>/webfetch/ when markdown exceeds PAGE_TEXT_CHAR_CAP. ' +
          `Got writes: ${JSON.stringify(fsWrites.map((w) => w.path))}`,
      ).toBeDefined()

      // The persisted markdown is the FULL content, not a truncation.
      expect(markdownWrite!.size).toBeGreaterThan(100_000)
      expect(markdownWrite!.size).toBeCloseTo(result.content.length, -4)

      // The result exposes the path so PageReadTool.call() can
      // surface it to the model.
      expect(result.overflowMarkdownPath).toBe(markdownWrite!.path)
      expect(result.overflowMarkdownSize).toBe(markdownWrite!.size)

      utils.forgetFetchedPages()
    })

    it('does NOT persist markdown when content fits in PAGE_TEXT_CHAR_CAP', async () => {
      const utils = await import('../toolkit/builtin/webFetch/fetchHelpers')

      const fsWrites: Array<{ path: string }> = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stubFs: any = {
        async mkdir() {
          /* allow */
        },
        async writeFile(path: string) {
          fsWrites.push({ path })
        },
      }
      const fsOps = await import('../utils/fs/runtimeFs')
      fsOps.installProcessFs(stubFs)

      const deps: WebFetchDeps = {
        network: {
          httpGet: async () => ({
            status: 200,
            statusText: 'OK',
            finalUrl: 'https://example.test/small',
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: new TextEncoder().encode(
              '<!doctype html><html><body><h1>Tiny page</h1>' +
                '<p>One paragraph. That\'s it.</p></body></html>',
            ),
          }),
        },
        runtimeCwd: '/tmp/nexus-test',
      }

      utils.forgetFetchedPages()
      const result = await utils.capturePageAsMarkdown(
        'https://example.test/small',
        new AbortController(),
        deps,
      )
      if ('type' in result) return

      // Markdown is small — no overflow file should be created.
      expect(result.content.length).toBeLessThan(100_000)
      expect(result.overflowMarkdownPath).toBeUndefined()
      expect(
        fsWrites.filter((w) => /\.md$/.test(w.path)),
        'No .md persist file should be written when markdown fits ' +
          'in PAGE_TEXT_CHAR_CAP — avoids unnecessary disk writes ' +
          'on the common "short page" path',
      ).toEqual([])

      utils.forgetFetchedPages()
    })
  })
})

// =============================================================================
// WebFetch resolves `network` from `context.platformCapabilities.network` and the persist root from
// `context.options.projectRoot`, never a realm-shared slot.
// =============================================================================
describe('WebFetch resolves its deps from the caller context (no realm-shared slot)', () => {
  afterEach(() => {
    vi.resetModules()
  })

  type FakeHttpGet = WebFetchDeps['network']['httpGet']

  // `Tool.call` plumbing the fetch path never touches.
  const allowAll = (async () => ({ behavior: 'allow' })) as never
  const invokingRow = { type: 'user', uuid: 'parent-1' } as never

  function okHtml(body: string, finalUrl: string): ReturnType<FakeHttpGet> {
    return Promise.resolve({
      status: 200,
      statusText: 'OK',
      finalUrl,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: new TextEncoder().encode(body),
    })
  }

  async function makeContext(
    network: WebFetchDeps['network'] | undefined,
    projectRoot: string,
  ) {
    const { createNoopToolUseContext, NoopPlatformCapabilities, createEmptyAppState } =
      await import('../runtime/testing/noopAdapters')
    const context = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      projectRoot,
    })
    // The per-runtime host bridge surface — `BrowserHostBridge.network` in
    // production; a fake here so the test can see which runtime served.
    context.platformCapabilities = {
      ...context.platformCapabilities,
      ...(network ? { network } : {}),
    }
    return context
  }

  it('fetches through ITS OWN runtime after the last-booted sibling runtime was disposed', async () => {
    const utils = await import('../toolkit/builtin/webFetch/fetchHelpers')
    const { PageReadTool } = await import('../toolkit/builtin/webFetch/webFetch')

    // Runtime A — the user's session; its network answers.
    let aCalls = 0
    const networkA: WebFetchDeps['network'] = {
      httpGet: async () => {
        aCalls += 1
        return okHtml(
          '<!doctype html><html><body><h1>From runtime A</h1></body></html>',
          'https://example.test/a',
        )
      },
    }
    // Runtime B — a background sub-agent that booted AFTER A and was then
    // reaped: its scoped transport now rejects every request the way
    // AgentWorkerBridgeTransport does after cancelGeneration.
    let bCalls = 0
    const networkB: WebFetchDeps['network'] = {
      httpGet: async () => {
        bCalls += 1
        throw new DOMException('Runtime scope was disposed.', 'AbortError')
      },
    }
    // On the pre-fix tree B's boot is the LAST WRITER of the module-global
    // slot, so A's fetch goes through B and dies. Reproduce that write when
    // the slot API still exists (it does not on the fixed tree — the call is
    // a no-op there), so this case fails on the old code for the real reason.
    const legacy = utils as unknown as {
      rememberWebFetchDeps?: (deps: WebFetchDeps) => void
    }
    legacy.rememberWebFetchDeps?.({
      network: networkB,
      runtimeCwd: '/tmp/nexus-test/runtime-b',
    })

    const contextA = await makeContext(networkA, '/tmp/nexus-test/runtime-a')
    const contextB = await makeContext(networkB, '/tmp/nexus-test/runtime-b')
    void contextB

    utils.forgetFetchedPages()
    // No `providerId` on the context → the tool returns the raw markdown
    // without a fast-model pass (keeps the assertion on the FETCH path).
    const result = await PageReadTool.call(
      { url: 'https://example.test/a', prompt: 'summarize' },
      contextA,
      allowAll,
      invokingRow,
    )

    expect(aCalls, "A's fetch must go through A's own network").toBe(1)
    expect(bCalls, "the disposed sibling's network must never be consulted").toBe(0)
    expect(String(result.data)).toContain('From runtime A')

    utils.forgetFetchedPages()
  })

  it('reports the missing network capability instead of falling back to another runtime', async () => {
    const utils = await import('../toolkit/builtin/webFetch/fetchHelpers')
    const { PageReadTool } = await import('../toolkit/builtin/webFetch/webFetch')

    const context = await makeContext(undefined, '/tmp/nexus-test/no-network')
    utils.forgetFetchedPages()
    await expect(
      PageReadTool.call(
        { url: 'https://example.test/none', prompt: 'summarize' },
        context,
        allowAll,
        invokingRow,
      ),
    ).rejects.toThrow(/network capability is not available/)
  })

  it('persists overflow markdown under the CALLER runtime project root', async () => {
    const utils = await import('../toolkit/builtin/webFetch/fetchHelpers')
    const context = await makeContext(
      { httpGet: async () => okHtml('<html><body>x</body></html>', 'https://example.test/') },
      '/tmp/nexus-test/runtime-a',
    )
    const deps = utils.resolveWebFetchDeps(context)
    expect(deps.runtimeCwd).toBe('/tmp/nexus-test/runtime-a')
    expect(deps.network).toBe(context.platformCapabilities.network)
  })
})
