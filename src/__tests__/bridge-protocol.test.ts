import { describe, it, expect } from 'vitest'
import {
  checkUrlInterfaceVersion,
  createBridgeRoute,
  createLocalBrowserBridgeTransport,
  NEXUS_INTERFACE_VERSION,
  normalizeBrowserHostManifest,
  type BrowserBridgeFlatHandlers,
} from '../browser/bridge/browserBridgeProtocol'
import { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import { createBrowserFsOperations } from '../utils/BrowserFsOperations'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import { resolveSupportedSlashCommands } from '../input/slashCommandCatalog'
import {
  setSessionActive,
  sqliteClose,
  sqliteOpen,
  sqliteQuery,
  subscribeSessionTabsChanged,
} from '../browser/webview/nexusBridgeActions'
import { NEXUS_DIRECT_BRIDGE_CAPABILITIES } from '../browser/bridge/directBridgeCapabilities'

const TEXT_ENCODER = new TextEncoder()

// The imperative `tabs`, `navigation`, `snapshot`,
// `interaction`, `media`, and `downloads` capabilities were removed
// from the bridge protocol. The surviving JS-callable capabilities
// covered by these tests are `context`, `browser`, `model`, `fs`, and
// (out-of-band) `process`. The minimal handler dict reflects that.
function createMinimalHandlers(): BrowserBridgeFlatHandlers {
  return {
    // Lifecycle lives on the dedicated `session` capability.
    'session.onStop': async () => ({ ok: true as const, stopped: true }),
    'session.setAgentLoopSettings': async (p: {
      actionTimeoutMs?: number
    }) => ({
      ok: true as const,
      // Echo back the value so the test can verify the round-trip.
      appliedActionTimeoutMs: p.actionTimeoutMs,
    }),
    'model.catalog': async () => ({
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          iconSvg:
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>',
          enabled: true,
          defaultModelId: 'test-model',
          models: [
            {
              id: 'test-model',
              label: 'Test Model',
              enabled: true,
            },
          ],
        },
      ],
      defaultSelection: {
        providerId: 'openai',
        modelId: 'test-model',
      },
    }),
    'model.call': async () => ({
      message: {
        role: 'assistant' as const,
        content: [{ type: 'text', text: 'test response' }],
        model: 'test-model',
      },
    }),
    'model.streamStart': async () => ({ streamId: 'stream-1' }),
    'model.streamRead': async () => ({
      chunks: [],
      done: true,
    }),
    'fs.cwd': async () => '/test',
    'fs.stat': async () => ({
      size: 0,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      isFIFO: false,
      isSocket: false,
      isCharacterDevice: false,
      isBlockDevice: false,
    }),
    'fs.readdir': async () => [],
    'fs.readFile': async () => TEXT_ENCODER.encode(''),
    'fs.readFileBytes': async () => TEXT_ENCODER.encode(''),
    'fs.readRange': async () => ({
      data: TEXT_ENCODER.encode(''),
      bytesRead: 0,
    }),
    'fs.writeFile': async () => ({ ok: true as const }),
    'fs.appendFile': async () => ({ ok: true as const }),
    'fs.mkdir': async () => ({ ok: true as const }),
    'fs.unlink': async () => ({ ok: true as const }),
    'fs.exists': async () => true,
  }
}

describe('BrowserFsOperations.rename — wire-contract error mapping', () => {
  // The host's refusal strings (NexusFsHost::Rename) and the port service's
  // NOT_IMPLEMENTED code are the wire contract this mapping rides on; the
  // C++ side pins the strings in NexusFsHostTest.
  function fsWith(error?: { code: string; message: string }) {
    return createBrowserFsOperations({
      createRequestId: () => 'r1',
      transport: {
        request: async (req: { route: { action: string } }) => {
          if (req.route.action === 'cwd') return { ok: true, result: '/x' }
          if (error) return { ok: false, error }
          return { ok: true, result: { ok: true } }
        },
      } as never,
    })
  }

  it('succeeds silently on ok', async () => {
    await expect(fsWith().rename!('a', 'b')).resolves.toBeUndefined()
  })

  it.each([
    ['Source does not exist', 'NotFoundError', 'FS_ERROR'],
    ['Destination already exists', 'AlreadyExistsError', 'FS_ERROR'],
    ['Unsupported action for capability: rename', 'NotSupportedError', 'NOT_IMPLEMENTED'],
    ['disk detached', 'OperationError', 'FS_ERROR'],
  ])('maps "%s" to %s', async (message, name, code) => {
    await expect(
      fsWith({ code, message }).rename!('a', 'b'),
    ).rejects.toMatchObject({ name })
  })
})

describe('BrowserFsOperations.send — error shape for ok:false envelopes', () => {
  function failingFs(error: { code: string; message: string }) {
    return createBrowserFsOperations({
      createRequestId: () => 'r1',
      transport: {
        request: async (req: { route: { action: string } }) => {
          if (req.route.action === 'cwd') return { ok: true, result: '/x' }
          return { ok: false, error }
        },
      } as never,
    })
  }

  it('keeps the flattened `code: message` text the prefix classifiers anchor on', async () => {
    await expect(
      failingFs({ code: 'FS_ERROR', message: 'ENOENT: no such file or directory' })
        .readFile('/x/a', { encoding: 'utf-8' }),
    ).rejects.toMatchObject({
      message: 'FS_ERROR: ENOENT: no such file or directory',
      bridgeCode: 'FS_ERROR',
    })
  })

  it.each([
    ['ENOENT: no such file or directory', 'ENOENT'],
    ['EACCES: permission denied', 'EACCES'],
    ['ENOTDIR: not a directory', 'ENOTDIR'],
  ])('surfaces the host wire code "%s" as Node-style `.code` %s', async (message, code) => {
    await expect(
      failingFs({ code: 'FS_ERROR', message }).stat('/x/a'),
    ).rejects.toMatchObject({ code, bridgeCode: 'FS_ERROR' })
  })

  it.each([
    ['FS_ERROR', 'Failed to read file'],
    ['transport_disposed', 'DirectPortBridgeTransport has been disposed'],
    ['NOT_IMPLEMENTED', 'Unsupported action for capability: readFile'],
  ])('leaves `.code` unset for an undiscriminated %s envelope (only bridgeCode)', async (code, message) => {
    // `.code` follows the Node errno convention: a consumer that branches
    // `code !== 'ENOENT'` → "positively non-ENOENT" (the instruction-file probe)
    // must NOT see a generic envelope code there.
    let thrown: unknown
    try {
      await failingFs({ code, message }).readFile('/x/a', { encoding: 'utf-8' })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as { code?: unknown }).code).toBeUndefined()
    expect(thrown).toMatchObject({ bridgeCode: code, message: `${code}: ${message}` })
  })
})

describe('BrowserFsOperations.realpath — resolveLinks payload', () => {
  // The key is wire contract (NexusFsBridgeAdapterTest pins the C++ side). A
  // plain call must NOT carry it: the default form is the session cwd /
  // storage identity and must not start following links.
  function recordingFs() {
    const payloads: unknown[] = []
    const fs = createBrowserFsOperations({
      createRequestId: () => 'r1',
      transport: {
        request: async (req: { route: { action: string }; payload: unknown }) => {
          if (req.route.action === 'cwd') return { ok: true, result: '/x' }
          payloads.push(req.payload)
          return { ok: true, result: { path: '/real/a' } }
        },
      } as never,
    })
    return { fs, payloads }
  }

  it('sends resolveLinks only when asked', async () => {
    const { fs, payloads } = recordingFs()
    await expect(fs.realpath!('/x/a', { resolveLinks: true })).resolves.toBe('/real/a')
    await fs.realpath!('/x/a')
    expect(payloads).toEqual([{ path: '/x/a', resolveLinks: true }, { path: '/x/a' }])
  })
})

describe('BrowserBridgeProtocol', () => {
  it('normalizes browser host manifests from bootstrap payloads', () => {
    const manifest = normalizeBrowserHostManifest({
      hostKind: ' nexus ',
      capabilities: ['fs', 'model', 'fs', '', 123],
      toolNames: ['Read', 'show_location', 'Read'],
      commandNames: ['help', 'status', 'help'],
    })

    expect(manifest).toEqual({
      hostKind: 'nexus',
      capabilities: ['fs', 'model'],
      toolNames: ['Read', 'show_location'],
      commandNames: ['help', 'status'],
      hostedTools: [],
    })
  })

  // The host's promise that its LLM bridge takes a top-level `document` part.
  // Only a literal `true` counts: an older binary omits it, and the @-mention
  // step must then NOT inline a PDF (the bridge would fail the turn).
  it('reads llmDocumentParts only as a literal true', () => {
    expect(normalizeBrowserHostManifest({ llmDocumentParts: true })?.llmDocumentParts)
      .toBe(true)
    expect(normalizeBrowserHostManifest({ llmDocumentParts: 'true' })?.llmDocumentParts)
      .toBeUndefined()
    expect(normalizeBrowserHostManifest({})?.llmDocumentParts).toBeUndefined()
  })

  it('normalizes hosted tools from the manifest payload', () => {
    const manifest = normalizeBrowserHostManifest({
      capabilities: ['fs', 'model', 'browser'],
      hostedTools: [
        {
          type: 'function',
          name: 'browser_navigate',
          description: 'Navigate the active tab.',
          parameters: { type: 'object', properties: {} },
        },
        {
          type: 'function',
          name: 'browser_click',
          description: 'Click a page element.',
          parameters: { type: 'object', properties: {} },
        },
      ],
    })

    expect(manifest).toEqual({
      hostKind: undefined,
      capabilities: ['fs', 'model', 'browser'],
      toolNames: ['browser_navigate', 'browser_click'],
      commandNames: [],
      hostedTools: [
        {
          type: 'function',
          name: 'browser_navigate',
          description: 'Navigate the active tab.',
          parameters: { type: 'object', properties: {} },
          aliases: [],
          searchHint: undefined,
          readOnly: false,
          concurrencySafe: false,
        },
        {
          type: 'function',
          name: 'browser_click',
          description: 'Click a page element.',
          parameters: { type: 'object', properties: {} },
          aliases: [],
          searchHint: undefined,
          readOnly: false,
          concurrencySafe: false,
        },
      ],
    })
  })

  it('normalizes hosted tool concurrency-safe metadata explicitly', () => {
    const manifest = normalizeBrowserHostManifest({
      capabilities: ['browser'],
      hostedTools: [
        {
          type: 'function',
          name: 'Read',
          description: 'Read a file.',
          parameters: { type: 'object', properties: {} },
          readOnly: true,
          concurrencySafe: true,
        },
        {
          type: 'function',
          name: 'BrowserReadPage',
          description: 'Read the current page.',
          parameters: { type: 'object', properties: {} },
          readOnly: true,
        },
      ],
    })

    expect(manifest?.hostedTools.map(t => ({
      name: t.name,
      readOnly: t.readOnly,
      concurrencySafe: t.concurrencySafe,
    }))).toEqual([
      { name: 'Read', readOnly: true, concurrencySafe: true },
      { name: 'BrowserReadPage', readOnly: true, concurrencySafe: false },
    ])
  })

  it('normalizes each hosted skill (name/description/toolNames) and DROPS any `default`', () => {
    // The per-skill `default` deferral marker is GONE — deferral lives SOLELY in
    // the session template's `deferredTools`. The normalizer keeps name /
    // description / instructions / toolNames and drops any `default` the host
    // still sends.
    const manifest = normalizeBrowserHostManifest({
      capabilities: ['fs', 'model', 'browser'],
      hostedSkills: [
        { name: 'browser', description: 'Drive the browser.', default: 'deferred', toolNames: ['BrowserClick'] },
        { name: 'core', description: 'Always on.', default: 'always_on' },
        { name: 'legacy', description: 'No default.' },
      ],
    })

    const byName = Object.fromEntries(
      (manifest?.hostedSkills ?? []).map(s => [s.name, s]),
    )
    expect(byName['browser']?.toolNames).toEqual(['BrowserClick'])
    expect(byName['browser']?.description).toBe('Drive the browser.')
    expect(byName['core']).toBeDefined()
    expect(byName['legacy']).toBeDefined()
    // Neither `default` nor the older `defaultDeferred` survives normalization.
    expect('default' in (byName['browser'] ?? {})).toBe(false)
    expect('defaultDeferred' in (byName['browser'] ?? {})).toBe(false)
  })

  it('checkUrlInterfaceVersion: trailing /v<N>/ must equal the build constant', () => {
    const v = NEXUS_INTERFACE_VERSION
    // The binary loads `{base}/v<N>/` (Cloudflare may serve the explicit
    // index.html) — both spellings must match.
    expect(checkUrlInterfaceVersion(`/v${v}/`)).toEqual({
      kind: 'match',
      pathVersion: v,
    })
    expect(checkUrlInterfaceVersion(`/v${v}/index.html`)).toEqual({
      kind: 'match',
      pathVersion: v,
    })
    // Self-hosted bases keep their own path prefix; only the TRAILING
    // segment counts — a version-looking directory earlier in the base
    // (…/apps/v99/…) must not shadow the appended one.
    expect(checkUrlInterfaceVersion(`/apps/v99/nexus/v${v}/`)).toEqual({
      kind: 'match',
      pathVersion: v,
    })
    expect(checkUrlInterfaceVersion(`/v${v + 1}/`)).toEqual({
      kind: 'mismatch',
      pathVersion: v + 1,
      guestVersion: v,
    })
  })

  it('checkUrlInterfaceVersion: immutable build-entry paths still carry the version', () => {
    // WP-1 stages a remote-bootable entry at /v<N>/b/<buildKey>/ (buildKey =
    // the nexus-build-time meta with - : . stripped). The entry path must NOT
    // read as 'unversioned' — that would silently skip the tripwire.
    const v = NEXUS_INTERFACE_VERSION
    const key = '20260917T103000000Z'
    expect(checkUrlInterfaceVersion(`/v${v}/b/${key}/`)).toEqual({
      kind: 'match',
      pathVersion: v,
    })
    expect(checkUrlInterfaceVersion(`/v${v}/b/${key}/index.html`)).toEqual({
      kind: 'match',
      pathVersion: v,
    })
    expect(checkUrlInterfaceVersion(`/v${v + 1}/b/${key}/`)).toEqual({
      kind: 'mismatch',
      pathVersion: v + 1,
      guestVersion: v,
    })
    // Self-hosted prefix: the LAST /v<K>/ before the end wins, not an earlier
    // version-looking segment.
    expect(checkUrlInterfaceVersion(`/apps/v99/nexus/v${v}/b/${key}/`)).toEqual({
      kind: 'match',
      pathVersion: v,
    })
    // A bare or malformed build-key segment is not a build entry — fall through
    // to 'unversioned' (the trailing version segment is then /v<N>/b/, which
    // does not match the /v<N>/ shape either).
    expect(checkUrlInterfaceVersion(`/v${v}/b/`)).toEqual({ kind: 'unversioned' })
    expect(checkUrlInterfaceVersion(`/v${v}/b/x y/`)).toEqual({ kind: 'unversioned' })
    expect(checkUrlInterfaceVersion(`/v${v}/b/20260917T103000/`)).toEqual({
      kind: 'unversioned',
    })
  })

  it('checkUrlInterfaceVersion: unversioned paths (dev server, frozen root) skip the check', () => {
    expect(checkUrlInterfaceVersion('/')).toEqual({ kind: 'unversioned' })
    expect(checkUrlInterfaceVersion('/index.html')).toEqual({
      kind: 'unversioned',
    })
    // Not trailing → not the binary-appended segment.
    expect(checkUrlInterfaceVersion('/v1/deeper/page')).toEqual({
      kind: 'unversioned',
    })
    // Version-ish but malformed segments don't count.
    expect(checkUrlInterfaceVersion('/version2/')).toEqual({
      kind: 'unversioned',
    })
    expect(checkUrlInterfaceVersion('/v/')).toEqual({ kind: 'unversioned' })
  })

  it('filters manifest slash commands to the runtime command surface', () => {
    expect(
      resolveSupportedSlashCommands(['help', 'status', 'future_command', 'help']),
    ).toEqual(['help', 'status'])
    expect(resolveSupportedSlashCommands([])).toEqual([])
  })

  it('creates a local transport that resolves requests', async () => {
    const transport = createLocalBrowserBridgeTransport(createMinimalHandlers())

    const response = await transport.request({
      id: 'req-1',
      route: createBridgeRoute('session', 'onStop'),
      payload: {},
    })

    expect(response.ok).toBe(true)
    if (response.ok) {
      expect(response.result).toEqual({ ok: true, stopped: true })
    }
  })

  it('returns error responses for failing handlers', async () => {
    const handlers = createMinimalHandlers()
    handlers['session.onStop'] = async () => {
      throw new Error('test error')
    }
    const transport = createLocalBrowserBridgeTransport(handlers)

    const response = await transport.request({
      id: 'req-2',
      route: createBridgeRoute('session', 'onStop'),
      payload: {},
    })

    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.message).toBe('test error')
      expect(response.error.code).toBe('bridge_handler_error')
    }
  })

  it('preserves request IDs in responses', async () => {
    const transport = createLocalBrowserBridgeTransport(createMinimalHandlers())

    const response = await transport.request({
      id: 'my-unique-id',
      route: createBridgeRoute('session', 'onStop'),
      payload: {},
    })

    expect(response.id).toBe('my-unique-id')
  })
})

describe('BrowserHostBridge', () => {
  it('wraps transport calls through PlatformCapabilities', async () => {
    const transport = createLocalBrowserBridgeTransport(createMinimalHandlers())
    const config = new BrowserRuntimeConfig()
    const bridge = new BrowserHostBridge({ transport, runtimeConfig: config })

    // The session is built page-side (no host served a `context` route).
    const session = await bridge.describeHostSession()
    expect(session.browserName).toBe('Chromium-hosted runtime')

    // The C++-side `session` capability hosts the LLM-session
    // lifecycle.
    const stopResult = await bridge.session.onStop({
      sessionId: 'session-1',
      reason: 'user_stopped',
    })
    expect(stopResult.ok).toBe(true)
    expect(stopResult.stopped).toBe(true)
  })

  // Regression test for the agent-loop integration: the
  // `BrowserHostBridge.session.setAgentLoopSettings` JS-side helper
  // was missing for one revision of the patch series, so
  // `QueryEngine.pushAgentLoopSettingsToHost` short-circuited on
  // optional chaining and silently dropped every push. The fix wires
  // the helper through to the C++ session adapter, on the `session`
  // capability.
  it('forwards setAgentLoopSettings through the session capability', async () => {
    let captured: {
      actionTimeoutMs?: number
      clearReadState?: boolean
      browserObservationDiffOptIn?: boolean
      clearBrowserObservationCache?: boolean
    } | null = null
    const handlers = {
      ...createMinimalHandlers(),
      'session.setAgentLoopSettings': async (p: {
        actionTimeoutMs?: number
        clearReadState?: boolean
        browserObservationDiffOptIn?: boolean
        clearBrowserObservationCache?: boolean
      }) => {
        captured = p
        return { ok: true as const, appliedActionTimeoutMs: p.actionTimeoutMs }
      },
    }
    const transport = createLocalBrowserBridgeTransport(handlers)
    const config = new BrowserRuntimeConfig()
    const bridge = new BrowserHostBridge({ transport, runtimeConfig: config })

    const result = await bridge.session.setAgentLoopSettings({
      actionTimeoutMs: 45_000,
      clearReadState: true,
      // T0-c: the new-guest handshake + observation-cache-clear signal
      // must ride the same setAgentLoopSettings wire call.
      browserObservationDiffOptIn: true,
      clearBrowserObservationCache: true,
      executionContext: { sessionId: 'session-1' },
    })

    expect(result.ok).toBe(true)
    expect(result.appliedActionTimeoutMs).toBe(45_000)
    expect(captured).not.toBeNull()
    expect(captured!.actionTimeoutMs).toBe(45_000)
    expect(captured!.clearReadState).toBe(true)
    expect(captured!.browserObservationDiffOptIn).toBe(true)
    expect(captured!.clearBrowserObservationCache).toBe(true)
  })

  // The pre-refactor `onBrowserToolDispatched` reveal chokepoint (and its
  // three regression tests) is gone: the browser pane now follows the
  // session's REAL tab state via `session.setActiveSession` +
  // `browser.sessionTabsChanged` (covered below) — a dispatch that never
  // creates a tab no longer reveals an empty pane.
  it('dispatches hosted tools through browser.callTool', async () => {
    const handlers = {
      ...createMinimalHandlers(),
      // The tool name resolves to the host action behind it.
      'browser.navigate': async () => ({ data: { ok: true } }),
    }
    const transport = createLocalBrowserBridgeTransport(handlers)
    const bridge = new BrowserHostBridge({ transport })
    const result = await bridge.browser.callTool({
      name: 'BrowserNavigate',
      args: {
        evaluation_previous_goal: 'none yet',
        memory: '',
        next_goal: 'open the page',
        url: 'https://example.com',
      },
    })
    expect(result).toEqual({ data: { ok: true } })
  })

  // WebFetch's fetch surface rides the per-runtime host bridge
  // (`context.platformCapabilities.network`) — every bridge instance must
  // expose `network.httpGet` over ITS OWN transport, mapping the caller
  // options 1:1 onto the `network.httpGet` payload (minus `signal`).
  it('exposes network.httpGet through its own transport', async () => {
    let captured: Record<string, unknown> | null = null
    const handlers = {
      ...createMinimalHandlers(),
      'network.httpGet': async (payload: unknown) => {
        captured = payload as Record<string, unknown>
        return {
          status: 200,
          statusText: 'OK',
          finalUrl: 'https://example.com/',
          headers: { 'content-type': 'text/plain' },
          body: new Uint8Array([104, 105]),
        }
      },
    }
    const transport = createLocalBrowserBridgeTransport(handlers)
    const bridge = new BrowserHostBridge({ transport })

    const result = await bridge.network.httpGet('https://example.com/', {
      timeoutMs: 1_000,
      maxResponseBytes: 2_048,
      signal: new AbortController().signal,
    })

    expect(result.status).toBe(200)
    expect(captured).toEqual({
      url: 'https://example.com/',
      timeoutMs: 1_000,
      maxResponseBytes: 2_048,
    })

    // Two bridges → two independent surfaces (the whole point: no shared
    // module slot behind them).
    const other = new BrowserHostBridge({
      transport: createLocalBrowserBridgeTransport({
        ...createMinimalHandlers(),
        'network.httpGet': async () => {
          throw new Error('other transport must not be used')
        },
      }),
    })
    expect(other.network).not.toBe(bridge.network)
    await expect(
      bridge.network.httpGet('https://example.com/again'),
    ).resolves.toMatchObject({ status: 200 })
  })

  // Regression guard for the webview_area visibility seed: the guest
  // calls `setSessionActive` on boot + every switch, and the C++ reply's
  // tab counts are the ONLY initial source for the per-session
  // visibility map (live updates ride browser.sessionTabsChanged). A
  // missing helper or a payload-shape drift silently leaves the browser
  // pane hidden forever.
  it('forwards session.setActiveSession and returns the tab counts', async () => {
    let captured: { sessionId?: string } | null = null
    const handlers = {
      ...createMinimalHandlers(),
      'session.setActiveSession': async (p: { sessionId: string }) => {
        captured = p
        return {
          ok: true as const,
          activated: true,
          nexusTabCount: 1,
          totalTabCount: 2,
        }
      },
    }
    const transport = createLocalBrowserBridgeTransport(handlers)

    const result = await setSessionActive(transport, 'session-1')

    expect(result.ok).toBe(true)
    expect(result.activated).toBe(true)
    expect(result.nexusTabCount).toBe(1)
    expect(result.totalTabCount).toBe(2)
    expect(captured).not.toBeNull()
    expect(captured!.sessionId).toBe('session-1')
  })

  it('subscribeSessionTabsChanged filters to browser.sessionTabsChanged', () => {
    let listener: ((envelope: {
      route: { namespace: string; capability: string; action: string }
      payload: Record<string, unknown>
    }) => void) | null = null
    let unsubscribed = false
    const transport = {
      request: async () => {
        throw new Error('not used')
      },
      subscribeEvents: (
        handler: (envelope: {
          route: { namespace: string; capability: string; action: string }
          payload: Record<string, unknown>
        }) => void,
      ) => {
        listener = handler
        return () => {
          unsubscribed = true
        }
      },
    } as unknown as Parameters<typeof subscribeSessionTabsChanged>[0]

    const received: unknown[] = []
    const unsubscribe = subscribeSessionTabsChanged(transport, event => {
      received.push(event)
    })
    expect(listener).not.toBeNull()

    // Foreign event on the same channel — must be ignored.
    listener!({
      route: { namespace: 'nexus', capability: 'session', action: 'applyAgentConfig' },
      payload: { config: {} },
    })
    expect(received).toHaveLength(0)

    listener!({
      route: { namespace: 'nexus', capability: 'browser', action: 'sessionTabsChanged' },
      payload: { sessionId: 's1', nexusTabCount: 1, totalTabCount: 1 },
    })
    expect(received).toEqual([
      { sessionId: 's1', nexusTabCount: 1, totalTabCount: 1 },
    ])

    unsubscribe()
    expect(unsubscribed).toBe(true)
  })

  it('provides browser context snapshots', async () => {
    const transport = createLocalBrowserBridgeTransport(createMinimalHandlers())
    const bridge = new BrowserHostBridge({ transport })

    // Tabs / DOM / accessibility snapshots are no longer
    // populated; no host serves a user profile or workspace.
    const snapshot = await bridge.getBrowserContextSnapshot()
    expect(snapshot.tabs).toEqual([])
    expect(snapshot.activeTab).toBeNull()
    expect(snapshot.domSnapshot).toBeNull()
    expect(snapshot.accessibilitySnapshot).toBeNull()
    expect(snapshot.userProfile).toBeNull()
    expect(snapshot.workspace).toBeNull()
    expect(snapshot.session.browserName).toBe('Chromium-hosted runtime')
  })

  it('uses the host manifest to gate Nexus capabilities', async () => {
    const transport = createLocalBrowserBridgeTransport(createMinimalHandlers())
    const bridge = new BrowserHostBridge({
      transport,
      hostMode: 'nexus',
      hostManifest: {
        capabilities: ['fs', 'model'],
        toolNames: [],
        commandNames: [],
        hostedTools: [],
      },
    })

    // `session` capability is not advertised — onStop should throw
    // NOT_IMPLEMENTED.
    await expect(
      bridge.session.onStop({ sessionId: 'session-1' }),
    ).rejects.toThrow(/NOT_IMPLEMENTED/)
  })

  it('returns the page-built snapshot in nexus mode', async () => {
    const transport = createLocalBrowserBridgeTransport(createMinimalHandlers())
    const bridge = new BrowserHostBridge({
      transport,
      hostMode: 'nexus',
      hostManifest: {
        capabilities: ['browser'],
        toolNames: [],
        commandNames: [],
        hostedTools: [],
      },
    })

    const snapshot = await bridge.getBrowserContextSnapshot()

    expect(snapshot.tabs).toEqual([])
    expect(snapshot.activeTab).toBeNull()
    expect(snapshot.session.browserName).toBe('Velloc Code')
    expect(snapshot.session.tabCount).toBe(0)
  })

  it('the fallback snapshot still carries the host system info (the Nexus production path)', async () => {
    // This snapshot is what every prompt's # Environment block is built from. Without the merge it had no
    // Platform / OS Version / Shell lines.
    const transport = createLocalBrowserBridgeTransport({
      ...createMinimalHandlers(),
      'fs.systemInfo': async () => ({
        platform: 'win32',
        osVersion: 'Windows 11 Pro 10.0.26200',
        shell: 'bash',
      }),
    })
    const manifest = (capabilities: string[]) => ({
      capabilities: capabilities as never,
      toolNames: [],
      commandNames: [],
      hostedTools: [],
    })

    const withFs = new BrowserHostBridge({ transport, hostMode: 'nexus', hostManifest: manifest(['browser', 'fs']) })
    const snapshot = await withFs.getBrowserContextSnapshot()
    expect(snapshot.session).toMatchObject({
      browserName: 'Velloc Code',
      platform: 'win32',
      osVersion: 'Windows 11 Pro 10.0.26200',
      shell: 'bash',
    })

    // A host without `fs` is not asked, and the session stays the plain fallback.
    const withoutFs = new BrowserHostBridge({ transport, hostMode: 'nexus', hostManifest: manifest(['browser']) })
    const bare = (await withoutFs.getBrowserContextSnapshot()).session
    expect(bare.platform).toBeUndefined()
    expect(bare.shell).toBeUndefined()
  })
})

describe('BrowserHostBridge — fs.systemInfo memo', () => {
  const manifest = {
    capabilities: ['browser', 'fs'] as never,
    toolNames: [],
    commandNames: [],
    hostedTools: [],
  }
  const info = { platform: 'win32', osVersion: 'Windows 11', shell: 'bash' }

  it('asks the host for systemInfo once per bridge, not once per session read', async () => {
    // The fallback context snapshot is built for every query and every
    // attachment resolution, and each build read `fs.systemInfo` again — a
    // host round trip for a value that cannot change while the process lives.
    let calls = 0
    const transport = createLocalBrowserBridgeTransport({
      ...createMinimalHandlers(),
      'fs.systemInfo': async () => {
        calls += 1
        return info
      },
    })
    const bridge = new BrowserHostBridge({ transport, hostMode: 'nexus', hostManifest: manifest })

    const [a, b] = await Promise.all([bridge.describeHostSession(), bridge.describeHostSession()])
    await bridge.getBrowserContextSnapshot()
    expect(a.platform).toBe('win32')
    expect(b.shell).toBe('bash')
    expect(calls, 'one fs.systemInfo round trip for three session reads').toBe(1)
  })

  it('does not cache a failed read as a permanent miss', async () => {
    let calls = 0
    const transport = createLocalBrowserBridgeTransport({
      ...createMinimalHandlers(),
      'fs.systemInfo': async () => {
        calls += 1
        if (calls === 1) throw new Error('host not ready')
        return info
      },
    })
    const bridge = new BrowserHostBridge({ transport, hostMode: 'nexus', hostManifest: manifest })

    const first = await bridge.describeHostSession()
    expect(first.platform, 'the failed read drops the fields, silently').toBeUndefined()
    const second = await bridge.describeHostSession()
    expect(second.platform, 'the next read retries the host').toBe('win32')
    await bridge.describeHostSession()
    expect(calls, 'the successful read is the one that is memoised').toBe(2)
  })
})

describe('sqlite bridge', () => {
  it('routes sqliteQuery through sqlite.query and returns typed rows', async () => {
    let captured: unknown = null
    const handlers = {
      ...createMinimalHandlers(),
      'sqlite.query': async (p: unknown) => {
        captured = p
        return { rows: [[1, 'alice']], rowCount: 1, truncated: false }
      },
    }
    const transport = createLocalBrowserBridgeTransport(handlers)

    const result = await sqliteQuery(transport, {
      path: '/tmp/x.sqlite',
      sql: 'SELECT id, name FROM t',
    })

    expect(result.rowCount).toBe(1)
    expect(result.rows).toEqual([[1, 'alice']])
    expect(captured).toEqual({
      path: '/tmp/x.sqlite',
      sql: 'SELECT id, name FROM t',
    })
  })

  it('routes the open → close handle lifecycle', async () => {
    const calls: string[] = []
    const handlers = {
      ...createMinimalHandlers(),
      'sqlite.open': async () => {
        calls.push('open')
        return { handle: 'sqlite:1' }
      },
      'sqlite.close': async (p: { handle: string }) => {
        calls.push(`close:${p.handle}`)
        return { ok: true as const }
      },
    }
    const transport = createLocalBrowserBridgeTransport(handlers)

    const opened = await sqliteOpen(transport, { path: '/tmp/x.sqlite' })
    expect(opened.handle).toBe('sqlite:1')
    const closed = await sqliteClose(transport, opened.handle)
    expect(closed.ok).toBe(true)
    expect(calls).toEqual(['open', 'close:sqlite:1'])
  })

  it('routes sqlite over the DIRECT C++ bridge (not a worker adapter)', () => {
    // The mirror of the C++ RegisterCapability("sqlite", ...) — without this
    // the SharedWorker would never forward sqlite requests to the host.
    expect(NEXUS_DIRECT_BRIDGE_CAPABILITIES.has('sqlite')).toBe(true)
  })

  it('the runtime reaches every C++ guest-port capability directly — none is relayed through a page', () => {
    // RegisterCapability(...) in nexus_bridge_port_service.cc, kGuest mode. The
    // worker's `network.httpGet` (WebFetch, provider model lists), native MCP
    // and search once went through whichever page showed the session.
    for (const capability of ['fs', 'model', 'network', 'session', 'search', 'shell', 'sqlite', 'ui', 'browser'] as const) {
      expect(NEXUS_DIRECT_BRIDGE_CAPABILITIES.has(capability), capability).toBe(true)
    }
  })
})
