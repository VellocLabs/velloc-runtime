// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'

import { ModelsSection, settleEchoedOrder } from '../browser/webview/settings/sections/ModelsSection'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { BrowserLlmCatalog } from '../browser/bridge/protocol/nexus_llm'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import { OPENCODE_ZEN_USER_AGENT } from '../config/opencodeZen'
import { hasUnsavedEdits } from '../glic/unsavedEditsGate'

// OpenCode Zen is switched off in the product (`OPENCODE_ZEN_ENABLED`); the
// preset flow below switches it on through this getter.
const zenSwitch = vi.hoisted(() => ({ enabled: false }))
vi.mock('../config/opencodeZen', async importOriginal => {
  const actual = await importOriginal<typeof import('../config/opencodeZen')>()
  return {
    ...actual,
    get OPENCODE_ZEN_ENABLED() {
      return zenSwitch.enabled
    },
  }
})

/**
 * ModelsSection: the Base URL placeholder is the selected provider's default; there is no "Save" button; typing an
 * API key auto-connects (providers.upsert, then providers.verify with the stored key, then providers.setActive).
 */

const OPENAI_BASE_URL = 'https://api.openai.com/v1'

const catalog: BrowserLlmCatalog = {
  providers: [
    {
      id: 'openai',
      label: 'OpenAI',
      iconSvg: '',
      enabled: true,
      defaultModelId: 'gpt-x',
      models: [{ id: 'gpt-x', label: 'GPT X', enabled: true }],
    },
  ],
}

type Calls = {
  /** The host's DRAFT-key probe (`providerAuth.verify`). */
  verify: number
  /** The runtime's stored-key probe (`providers.verify`). */
  runtimeVerify: number
  upsert: number
  setActive: number
  remove: number
}

function makeHarness(initialConfigs: Record<string, NexusProviderConfig> = {}) {
  const calls: Calls = { verify: 0, runtimeVerify: 0, upsert: 0, setActive: 0, remove: 0 }
  const upserts: { id: string; config: NexusProviderConfig }[] = []
  const order: string[] = []
  let configs: Record<string, NexusProviderConfig> = { ...initialConfigs }
  // A `providers.changed` broadcast the test raises by hand: nothing orders it against `providers.list` responses,
  // so one raised by an earlier write can arrive after a later write. Every subscriber hears it.
  const subscribers = new Set<(envelope: unknown) => void>()
  const onEvent = (envelope: unknown) => {
    for (const subscriber of [...subscribers]) subscriber(envelope)
  }
  const emitProvidersChanged = (payload: Record<string, NexusProviderConfig>) => {
    onEvent({
      route: { capability: 'providers', action: 'changed' },
      payload: { configs: payload, activeProviderId },
    })
  }
  let activeProviderId: string | undefined = Object.keys(initialConfigs)[0]

  // Host DIRECT bridge: providerAuth.list (registry) + providerAuth.verify.
  const transport = {
    request: vi.fn(async (req: { route: { action: string } }) => {
      switch (req.route.action) {
        case 'list':
          return {
            ok: true,
            result: {
              providers: [
                {
                  id: 'openai',
                  name: 'OpenAI',
                  type: 'cloud',
                  authMode: 'apiKey',
                  baseUrl: OPENAI_BASE_URL,
                  hasDefaultBaseUrl: true,
                },
              ],
            },
          }
        case 'verify':
          calls.verify += 1
          return { ok: true, result: { success: true, verifiedAtMs: 123 } }
        default:
          return { ok: true, result: {} }
      }
    }),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport

  // Worker settings bridge: providers.list / upsert / setActive (+ events).
  const bridge = {
    request: vi.fn(
      async (
        route: { action: string },
        payload: { id?: string; config?: NexusProviderConfig },
      ) => {
        switch (route.action) {
          case 'list':
            return { configs, activeProviderId }
          case 'upsert':
            calls.upsert += 1
            order.push('upsert')
            upserts.push({ id: payload.id!, config: payload.config! })
            configs = { ...configs, [payload.id!]: payload.config! }
            activeProviderId = activeProviderId ?? payload.id
            return { ok: true, configs, activeProviderId }
          case 'remove': {
            calls.remove += 1
            const next = { ...configs }
            delete next[payload.id!]
            configs = next
            activeProviderId = undefined
            return { ok: true, configs, activeProviderId }
          }
          case 'setActive':
            calls.setActive += 1
            activeProviderId = payload.id
            return { ok: true, configs, activeProviderId }
          case 'verify':
            calls.runtimeVerify += 1
            order.push('verify')
            return { ok: true, verifiedAtMs: 456 }
          default:
            return {}
        }
      },
    ),
    subscribeEvents: (listener: (envelope: unknown) => void) => {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    },
  } as unknown as NexusSettingsBridge

  return { calls, upserts, order, transport, bridge, emitProvidersChanged }
}

type BridgeRequestMock = Mock<(route: { action: string }, payload: unknown) => Promise<any>>

/** Answer with keys sealed, as the worker adapter does: a stored key reads back as `hasApiKey` only. */
function sealKeysInResponses(bridge: NexusSettingsBridge) {
  const request = bridge.request as unknown as BridgeRequestMock
  const inner = request.getMockImplementation()!
  request.mockImplementation(async (route, payload) => {
    const res = await inner(route, payload)
    if (!res?.configs) return res
    const configs: Record<string, NexusProviderConfig> = {}
    for (const [id, { apiKey, ...rest }] of Object.entries(res.configs as Record<string, NexusProviderConfig>)) {
      configs[id] = apiKey ? { ...rest, hasApiKey: true } : rest
    }
    return { ...res, configs }
  })
}

afterEach(() => {
  cleanup()
  zenSwitch.enabled = false
  ;(globalThis as { __nexusUnsavedEdits?: number }).__nexusUnsavedEdits = 0
})

/**
 * The page opens on the home list of added providers; the editor is reached
 * through a row's Settings button…
 */
async function openProviderSettings(id: string) {
  fireEvent.click(await screen.findByTestId(`models-provider-settings-${id}`))
}

/** …or through the "Add provider" dropdown. */
async function addProviderFromMenu(itemTestId: string) {
  fireEvent.keyDown(await screen.findByTestId('models-add-provider'), {
    key: 'Enter',
  })
  fireEvent.click(await screen.findByTestId(itemTestId))
}

const oauthCatalog: BrowserLlmCatalog = {
  providers: [
    {
      id: 'chatgpt-pro',
      label: 'ChatGPT Pro',
      iconSvg: '',
      enabled: true,
      defaultModelId: 'gpt-5.5',
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5', enabled: true }],
    },
  ],
}

/**
 * Harness for an OAuth (sign-in) provider like ChatGPT Pro. `beginOAuth`
 * returns a user code; `oauthStatus` reports NOT connected on the first poll
 * and connected on the second, mimicking the device-code dance completing in
 * the background. Connection state lives only in this fake broker registry —
 * settings.json (`providers.list`) never carries it — which is exactly why the
 * worker `providers.changed` broadcast never fires for OAuth.
 */
function makeOAuthHarness() {
  let statusPolls = 0
  const transport = {
    request: vi.fn(async (req: { route: { action: string } }) => {
      switch (req.route.action) {
        case 'list':
          return {
            ok: true,
            result: {
              providers: [
                {
                  id: 'chatgpt-pro',
                  name: 'ChatGPT Pro',
                  type: 'cloud',
                  authMode: 'oauth',
                  connected: statusPolls >= 2,
                },
              ],
            },
          }
        case 'beginOAuth':
          return {
            ok: true,
            result: {
              success: true,
              userCode: 'ABCD-1234',
              verificationUri: 'https://auth.example/device',
            },
          }
        case 'oauthStatus':
          statusPolls += 1
          return { ok: true, result: { connected: statusPolls >= 2 } }
        default:
          return { ok: true, result: {} }
      }
    }),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport

  // Worker settings bridge: OAuth never persists a config here, so `list`
  // stays empty and no `providers.changed` is broadcast.
  const bridge = {
    request: vi.fn(async (route: { action: string }) => {
      if (route.action === 'list') return { configs: {}, activeProviderId: undefined }
      return {}
    }),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge

  return { transport, bridge }
}

describe('ModelsSection auto-connect', () => {
  it('shows the per-provider default base URL, has no Save button, and auto-connects on key entry', async () => {
    const { calls, upserts, order, transport, bridge } = makeHarness()

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await addProviderFromMenu('models-provider-select-option-openai')

    // Bug 1: the Base URL placeholder is the selected provider's default,
    // surfaced once the registry round-trips (proves it is not the old
    // hard-coded Ollama URL).
    const baseUrlInput = await screen.findByPlaceholderText(OPENAI_BASE_URL)
    expect(baseUrlInput).toBeTruthy()

    // Bug 2: no explicit Save button.
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull()

    // Bug 2 + 4b: typing a key auto-connects and promotes active. openai is
    // verified in the runtime, which can only send a STORED key: the typed
    // key is saved first, then probed — never sent as a draft to the host.
    const keyInput = await screen.findByPlaceholderText('Enter your API key')
    fireEvent.change(keyInput, { target: { value: 'sk-test' } })

    await waitFor(() => expect(calls.runtimeVerify).toBeGreaterThan(0), {
      timeout: 3000,
    })
    await waitFor(() => expect(calls.setActive).toBeGreaterThan(0))
    expect(order.slice(0, 2)).toEqual(['upsert', 'verify'])
    expect(upserts[0]!.config.apiKey).toBe('sk-test')
    expect(calls.verify).toBe(0)
  })

  /**
   * A trust flip persists on its own (no verify probe, no setActive). The control is the "Official connection"
   * checkbox beside the API key, starting at the domain-derived default; both directions write an explicit marker.
   */
  it('persists a trust change immediately, in both directions', async () => {
    const { calls, upserts, transport, bridge } = makeHarness({
      openai: { hasApiKey: true, lastVerification: { providerId: 'openai', verifiedAtMs: 1 } },
    })

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')

    // The toggle shows the RESOLVED value, so an unset built-in provider
    // reads as an official connection without any stored marker.
    const toggle = (await screen.findByTestId(
      'models-trust-official',
    )) as HTMLInputElement
    expect(toggle.checked).toBe(true)

    fireEvent.click(toggle)

    await waitFor(() => expect(calls.upsert).toBe(1))
    expect(upserts[0]!.id).toBe('openai')
    expect(upserts[0]!.config.trust).toBe('untrusted')
    // Trust is not a credential: no probe, and no promotion to active.
    expect(calls.verify).toBe(0)
    expect(calls.setActive).toBe(0)
    // `""` would tell the upsert adapter to CLEAR the stored key.
    expect(upserts[0]!.config.apiKey).toBeUndefined()
    await waitFor(() =>
      expect(
        (screen.getByTestId('models-trust-official') as HTMLInputElement).checked,
      ).toBe(false),
    )

    // Back on writes the explicit 'trusted' marker - the checkbox has no third
    // "unset" state to fall back to.
    fireEvent.click(screen.getByTestId('models-trust-official'))
    await waitFor(() => expect(calls.upsert).toBe(2))
    expect(upserts[1]!.config.trust).toBe('trusted')
  })

  it('a trust flip never carries a typed, unverified key or keeps the old verification for it', async () => {
    const verified = { providerId: 'openai', verifiedAtMs: 1 }
    const { calls, upserts, transport, bridge } = makeHarness({
      openai: { hasApiKey: true, lastVerification: verified },
    })
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')
    const toggle = await screen.findByTestId('models-trust-official')
    const keyInput = await screen.findByLabelText('API key')
    // A new key typed, and the box flipped before the debounce probes it.
    fireEvent.change(keyInput, { target: { value: 'sk-unverified' } })
    fireEvent.click(toggle)
    await waitFor(() => expect(calls.upsert).toBeGreaterThanOrEqual(1))
    expect(upserts[0]!.config.trust).toBe('untrusted')
    expect(upserts[0]!.config.apiKey).toBeUndefined()
    expect(upserts[0]!.config.lastVerification).toEqual(verified)
  })

  it('a Base URL edit on a connected provider saves through the probe although the key field is empty', async () => {
    const { calls, upserts, transport, bridge } = makeHarness({
      openai: {
        hasApiKey: true,
        baseUrl: 'https://api.openai.com/v1',
        trust: 'trusted',
        lastVerification: { providerId: 'openai', verifiedAtMs: 1 },
      },
    })
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')
    const baseUrl = await screen.findByTestId('models-base-url')
    fireEvent.change(baseUrl, { target: { value: 'https://api.openai.com/v2' } })
    await waitFor(() => expect(calls.runtimeVerify).toBeGreaterThan(0), { timeout: 3000 })
    await waitFor(() =>
      expect(upserts.some(u => u.config.baseUrl === 'https://api.openai.com/v2')).toBe(true),
    )
    const saved = upserts.find(u => u.config.baseUrl === 'https://api.openai.com/v2')!
    // Absent key = keep the stored one; `""` would clear it.
    expect(saved.config.apiKey).toBeUndefined()
  })

  /**
   * A connected provider already reads "Connected" and "Saved"; once a replacement key is stored the field
   * empties, so the page says the new key landed — until the next keystroke or another provider.
   */
  it('confirms a replacement key once it is stored, and drops the note on the next edit', async () => {
    const { calls, transport, bridge } = makeHarness({
      openai: {
        hasApiKey: true,
        baseUrl: 'https://api.openai.com/v1',
        trust: 'trusted',
        lastVerification: { providerId: 'openai', verifiedAtMs: 1 },
      },
    })
    sealKeysInResponses(bridge)
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')
    const keyInput = await screen.findByTestId('models-api-key')
    expect(screen.queryByTestId('models-api-key-replaced')).toBeNull()

    fireEvent.change(keyInput, { target: { value: 'sk-new' } })
    expect(screen.queryByTestId('models-api-key-replaced')).toBeNull()
    await waitFor(() => expect(calls.setActive).toBeGreaterThan(0), { timeout: 3000 })
    const notice = await screen.findByTestId('models-api-key-replaced')
    expect(notice.textContent).toBe('New key saved.')

    fireEvent.change(keyInput, { target: { value: 'sk-n' } })
    expect(screen.queryByTestId('models-api-key-replaced')).toBeNull()
  })

  it('says nothing about a replacement key the probe rejected', async () => {
    const { calls, transport, bridge } = makeHarness({
      openai: {
        hasApiKey: true,
        baseUrl: 'https://api.openai.com/v1',
        trust: 'trusted',
        lastVerification: { providerId: 'openai', verifiedAtMs: 1 },
      },
    })
    const request = bridge.request as unknown as BridgeRequestMock
    const passThrough = request.getMockImplementation()!
    request.mockImplementation(async (route, payload) => {
      if (route.action === 'verify') {
        calls.runtimeVerify += 1
        return { ok: false, errorCode: 'auth_invalid_key' }
      }
      return passThrough(route, payload)
    })
    sealKeysInResponses(bridge)
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')
    fireEvent.change(await screen.findByTestId('models-api-key'), { target: { value: 'sk-bad' } })
    await waitFor(() => expect(calls.runtimeVerify).toBeGreaterThan(0), { timeout: 3000 })
    await waitFor(() => expect(calls.upsert).toBeGreaterThan(0))
    expect(screen.queryByTestId('models-api-key-replaced')).toBeNull()
  })

  /**
   * The base URL decides the checkbox; the user may override it; a later URL edit decides again.
   */
  it('re-derives the official-connection box from the base URL, and lets the user override until the URL changes again', async () => {
    const { transport, bridge } = makeHarness({
      openai: { hasApiKey: true, lastVerification: { providerId: 'openai', verifiedAtMs: 1 } },
    })

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')

    const box = () =>
      screen.getByTestId('models-trust-official') as HTMLInputElement
    await screen.findByTestId('models-trust-official')
    expect(box().checked).toBe(true)

    // Off-domain URL -> derived untrusted, with no click on the box at all.
    const baseUrl = screen.getByTestId('models-base-url')
    fireEvent.change(baseUrl, { target: { value: 'https://relay.example.test/v1' } })
    await waitFor(() => expect(box().checked).toBe(false))

    // The user says otherwise, and their answer stands.
    fireEvent.click(box())
    await waitFor(() => expect(box().checked).toBe(true))

    // …until the URL changes again, when the domain decides afresh.
    fireEvent.change(baseUrl, { target: { value: 'https://other-relay.test/v1' } })
    await waitFor(() => expect(box().checked).toBe(false))

    // And back onto the vendor's own domain re-ticks it.
    fireEvent.change(baseUrl, { target: { value: 'https://api.openai.com/v1' } })
    await waitFor(() => expect(box().checked).toBe(true))
  })

  /**
   * The URL-derived flip writes on its own, once per crossing, carrying the stored base URL.
   */
  it('persists the URL-derived flip without waiting for a credential change', async () => {
    const { calls, upserts, transport, bridge } = makeHarness({
      openai: {
        hasApiKey: true,
        baseUrl: 'https://api.openai.com/v1',
        lastVerification: { providerId: 'openai', verifiedAtMs: 1 },
      },
    })

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')

    const baseUrl = await screen.findByTestId('models-base-url')
    fireEvent.change(baseUrl, { target: { value: 'https://relay.example.test/v1' } })

    await waitFor(() => expect(calls.upsert).toBe(1))
    expect(upserts[0]!.config.trust).toBe('untrusted')
    // The half-typed URL must NOT ride along: the base URL has its own save
    // path, which waits for a complete, verifiable form.
    expect(upserts[0]!.config.baseUrl).toBe('https://api.openai.com/v1')
    // No probe and no promotion — trust is not a credential.
    expect(calls.verify).toBe(0)
    expect(calls.setActive).toBe(0)

    // Typing on within the same verdict writes nothing further.
    fireEvent.change(baseUrl, { target: { value: 'https://relay.example.test/v2' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(calls.upsert).toBe(1)

    // And the write must not eat the URL being typed. Every write here ends
    // in `reload()`, which used to reseed the form from the stored config —
    // so the trust marker landed and the half-typed URL vanished from the
    // field beside it.
    expect((baseUrl as HTMLInputElement).value).toBe('https://relay.example.test/v2')
  })

  it('never carries a key still being typed into the URL-derived trust write', async () => {
    const { calls, upserts, transport, bridge } = makeHarness({
      openai: {
        hasApiKey: true,
        baseUrl: 'https://api.openai.com/v1',
        lastVerification: { providerId: 'openai', verifiedAtMs: 1 },
      },
    })

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')

    // A new key half-pasted over a connected provider's stored one…
    const apiKey = await screen.findByTestId('models-api-key')
    fireEvent.change(apiKey, { target: { value: 'sk-ab' } })
    // …then the URL edit flips the derived trust and writes on its own.
    const baseUrl = await screen.findByTestId('models-base-url')
    fireEvent.change(baseUrl, { target: { value: 'https://relay.example.test/v1' } })

    await waitFor(() => expect(upserts.some(u => u.config.trust === 'untrusted')).toBe(true))
    const trustWrite = upserts.find(u => u.config.trust === 'untrusted')!
    // Absent = keep the stored key; the fragment must not replace it.
    expect(trustWrite.config.apiKey).toBeUndefined()
    expect(calls.upsert).toBeGreaterThan(0)
  })

  /**
   * The flip must survive an out-of-order snapshot (an earlier write's response landing after a later one).
   */
  it('writes the URL-derived flip even when a stale snapshot puts the old trust back', async () => {
    // The flip is a DOWNGRADE (vendor -> relay): only an 'untrusted' marker is
    // written ahead of the URL itself (see the test below for the upgrade).
    const stored: NexusProviderConfig = {
      hasApiKey: true,
      baseUrl: OPENAI_BASE_URL,
      trust: 'untrusted',
      lastVerification: { providerId: 'openai', verifiedAtMs: 1 },
    }
    const { calls, upserts, transport, bridge, emitProvidersChanged } =
      makeHarness({ openai: stored })

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')

    // The user ticks the box: an explicit 'trusted' reaches disk.
    const box = await screen.findByTestId('models-trust-official')
    fireEvent.click(box)
    await waitFor(() => expect(calls.upsert).toBe(1))
    expect(upserts[0]!.config.trust).toBe('trusted')

    // …and then a broadcast carrying the state from BEFORE that write arrives.
    await act(async () => {
      emitProvidersChanged({ openai: stored })
    })

    // Now the URL moves to a relay, which derives 'untrusted' — a real flip
    // away from the value just enforced.
    const baseUrl = screen.getByTestId('models-base-url')
    fireEvent.change(baseUrl, { target: { value: 'https://relay.example.test/v1' } })

    await waitFor(() => expect(calls.upsert).toBe(2))
    expect(upserts[1]!.config.trust).toBe('untrusted')
    // The immediate marker write (against the stored URL), not the
    // auto-connect save of the typed one that follows it.
    expect(upserts[1]!.config.baseUrl).toBe(OPENAI_BASE_URL)
    // And the stale snapshot must not resurface in the control either.
    await waitFor(() =>
      expect((screen.getByTestId('models-trust-official') as HTMLInputElement).checked).toBe(false),
    )
  })

  /**
   * The URL-derived write lands against the STORED base
   * URL, so an upgrade derived from the vendor URL typed over a stored relay
   * paired the relay with an explicit 'trusted' — and a failed probe or an
   * abandoned edit left it on disk, where a teammate spawn reads it.
   */
  it('never pairs the stored relay URL with a trust derived from the typed vendor URL', async () => {
    const RELAY = 'https://relay.example.test/v1'
    const { upserts, transport, bridge } = makeHarness({
      openai: {
        hasApiKey: true,
        baseUrl: RELAY,
        lastVerification: { providerId: 'openai', verifiedAtMs: 1 },
      },
    })

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')

    const box = () =>
      screen.getByTestId('models-trust-official') as HTMLInputElement
    await screen.findByTestId('models-trust-official')
    expect(box().checked).toBe(false)

    fireEvent.change(screen.getByTestId('models-base-url'), {
      target: { value: OPENAI_BASE_URL },
    })
    // The box follows the typed URL…
    await waitFor(() => expect(box().checked).toBe(true))
    // …and the 'trusted' reaches disk only together with that URL (the
    // auto-connect save), never as a marker on the stored relay.
    await waitFor(() =>
      expect(upserts.some(u => u.config.baseUrl === OPENAI_BASE_URL)).toBe(true),
      { timeout: 3000 },
    )
    expect(
      upserts.some(u => u.config.baseUrl === RELAY && u.config.trust === 'trusted'),
    ).toBe(false)
    const urlSave = upserts.find(u => u.config.baseUrl === OPENAI_BASE_URL)!
    expect(urlSave.config.trust).toBe('trusted')
  })

  /**
   * A reset drops the user's trust choice, including the enforced-trust pin: the reconnected config carries no
   * marker and resolves to the domain-derived default.
   */
  it('drops the enforced trust on a reset, so the reconnected config derives afresh', async () => {
    const stored: NexusProviderConfig = {
      hasApiKey: true,
      baseUrl: OPENAI_BASE_URL,
      lastVerification: { providerId: 'openai', verifiedAtMs: 1 },
    }
    const { calls, upserts, transport, bridge, emitProvidersChanged } =
      makeHarness({ openai: stored })

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')

    // 1. The user unticks the box: 'untrusted' reaches disk, and the page
    //    starts enforcing it.
    fireEvent.click(await screen.findByTestId('models-trust-official'))
    await waitFor(() => expect(calls.upsert).toBe(1))
    expect(upserts[0]!.config.trust).toBe('untrusted')

    // 2. Reset connection — the config is removed from disk.
    fireEvent.click(screen.getByRole('button', { name: 'Reset connection' }))
    const confirms = await screen.findAllByRole('button', {
      name: 'Reset connection',
    })
    fireEvent.click(confirms[confirms.length - 1]!)
    await waitFor(() => expect(calls.remove).toBe(1))

    // 3. The provider is set up again. A plain reconnect stores the key and
    //    nothing else — no trust marker, and no base URL override.
    const reconnected: NexusProviderConfig = {
      hasApiKey: true,
      lastVerification: { providerId: 'openai', verifiedAtMs: 2 },
    }
    await act(async () => {
      emitProvidersChanged({ openai: reconnected })
    })

    // The box shows the derived default for a vendor endpoint — trusted — not
    // the choice the reset dropped.
    await waitFor(() =>
      expect(
        (screen.getByTestId('models-trust-official') as HTMLInputElement).checked,
      ).toBe(true),
    )

    // …and the URL derivation compares against that same answer, so pointing
    // the provider at a relay still writes the flip.
    fireEvent.change(screen.getByTestId('models-base-url'), {
      target: { value: 'https://relay.example.test/v1' },
    })
    await waitFor(() => expect(calls.upsert).toBe(2))
    expect(upserts[1]!.config.trust).toBe('untrusted')
  })

  /**
   * The same clobber, reached the other way: the user ticks the checkbox while
   * the base URL is half-typed. The trust write reloads the provider list, and
   * before the reseed guard that reload threw the edit away.
   */
  it('keeps an in-progress base URL when the checkbox is ticked mid-edit', async () => {
    const { transport, bridge } = makeHarness({
      openai: {
        hasApiKey: true,
        baseUrl: 'https://api.openai.com/v1',
        lastVerification: { providerId: 'openai', verifiedAtMs: 1 },
      },
    })

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')

    const baseUrl = (await screen.findByTestId(
      'models-base-url',
    )) as HTMLInputElement
    fireEvent.change(baseUrl, { target: { value: 'https://gw.example.test/v' } })
    fireEvent.click(screen.getByTestId('models-trust-official'))

    await waitFor(() =>
      expect(
        (screen.getByTestId('models-trust-official') as HTMLInputElement).checked,
      ).toBe(true),
    )
    expect(
      (screen.getByTestId('models-base-url') as HTMLInputElement).value,
    ).toBe('https://gw.example.test/v')
  })

  /**
   * "Remove saved key" is gone: it did a subset of what "Reset connection"
   * does, and two controls for one intent is how a user ends up with a
   * half-cleared provider (key gone, base URL still pointing at a relay).
   */
  it('holds the background updater’s reload while a built-in form is dirty, and not on the home list', async () => {
    const { transport, bridge } = makeHarness()
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await screen.findByTestId('models-add-provider')
    expect(hasUnsavedEdits()).toBe(false)
    await addProviderFromMenu('models-provider-select-option-openai')
    const baseUrl = await screen.findByPlaceholderText(OPENAI_BASE_URL)
    expect(hasUnsavedEdits()).toBe(false)

    fireEvent.change(baseUrl, { target: { value: 'https://relay.example/v1' } })
    expect(hasUnsavedEdits()).toBe(true)
    fireEvent.change(baseUrl, { target: { value: '' } })
    expect(hasUnsavedEdits()).toBe(false)
  })

  it('offers no separate remove-saved-key button', async () => {
    const { transport, bridge } = makeHarness({
      openai: { hasApiKey: true, lastVerification: { providerId: 'openai', verifiedAtMs: 1 } },
    })

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport }),
      ),
    )
    await openProviderSettings('openai')

    await screen.findByTestId('models-api-key')
    expect(screen.queryByTestId('models-remove-api-key')).toBeNull()
  })

  // Regression: OAuth sign-in (e.g. ChatGPT Pro) connects on the C++ broker
  // and never round-trips through the worker `providers.*` capability, so it
  // never broadcasts `providers.changed`. Without an explicit
  // `onProviderConnected` signal the shell's model catalog stays stale and the
  // quick model picker misses the just-connected provider until an unrelated
  // focus/visibility refresh — the reported bug. This proves the OAuth success
  // path notifies the shell so it can refresh the catalog immediately.
  it('notifies onProviderConnected when an OAuth provider finishes signing in', async () => {
    const { transport, bridge } = makeOAuthHarness()
    const onProviderConnected = vi.fn()

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, {
          catalog: oauthCatalog,
          transport,
          onProviderConnected,
        }),
      ),
    )
    await addProviderFromMenu('models-provider-select-option-chatgpt-pro')

    // Registry round-trip reveals authMode:'oauth' → the sign-in button.
    const signInButton = await screen.findByRole('button', {
      name: /sign in/i,
    })

    // Drive the device-code poll: NOT connected on the first poll (t≈2s),
    // connected on the second (t≈4s), so advance past both.
    vi.useFakeTimers()
    try {
      fireEvent.click(signInButton)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
    } finally {
      vi.useRealTimers()
    }

    expect(onProviderConnected).toHaveBeenCalledTimes(1)
    // The sign-in window closed itself; the page says what happened.
    expect(screen.getByTestId('custom-provider-added-notice').textContent).toBe(`Signed in to ${oauthCatalog.providers[0]!.label}`)
  })
})

/**
 * Harness for a USER-CREATED custom provider. `providers.list` returns one
 * configured custom provider and points `activeProviderId` at it, so the page
 * opens straight into the custom editor — driving the portaled radix dropdown
 * isn't reliable in happy-dom, so the "+ Add custom provider…" entry point and
 * the dropdown grouping are covered by e2e instead.
 */
const CUSTOM_ID = 'custom-abc-provider'

function makeCustomProviderHarness(opts: { redactedKey?: boolean } = {}) {
  const calls = { verify: 0, upsert: 0, remove: 0 }
  const verifiedProviderIds: string[] = []
  const verifyUpdates: Array<Record<string, unknown>> = []
  const verifyKeyProviderIds: Array<string | undefined> = []
  const upserts: Array<{ id: string; config: NexusProviderConfig }> = []
  let configs: Record<string, NexusProviderConfig> = {
    [CUSTOM_ID]: {
      isCustomProvider: true,
      displayName: 'ABC Provider',
      providerIcon: 'generic',
      apiCompatibility: 'openai',
      baseUrl: 'https://api.abc.example/v1',
      // `redactedKey`: the view the WebUI really gets — the worker swaps a
      // stored key for `hasApiKey` (providersBridgeAdapter), so the draft
      // never carries it.
      ...(opts.redactedKey ? { hasApiKey: true } : { apiKey: 'sk-abc' }),
      defaultModel: 'abc-coder-v2',
      customModels: [
        {
          modelId: 'abc-coder-v2',
          displayName: 'ABC Coder',
          contextWindow: 262144,
          maxOutputTokens: 65536,
          capabilities: { toolCalling: true },
        },
      ],
    },
  }
  let activeProviderId: string | undefined = CUSTOM_ID

  const transport = {
    request: vi.fn(
      async (req: {
        route: { action: string }
        payload: {
          providerId?: string
          updates?: Record<string, unknown>
          keyProviderId?: string
        }
      }) => {
        switch (req.route.action) {
          case 'list':
            return {
              ok: true,
              result: {
                providers: [
                  {
                    id: 'openai',
                    name: 'OpenAI',
                    type: 'cloud',
                    authMode: 'apiKey',
                    baseUrl: OPENAI_BASE_URL,
                    hasDefaultBaseUrl: true,
                  },
                ],
              },
            }
          case 'verify':
            calls.verify += 1
            verifiedProviderIds.push(req.payload.providerId!)
            verifyUpdates.push(req.payload.updates ?? {})
            verifyKeyProviderIds.push(req.payload.keyProviderId)
            return {
              ok: true,
              result: {
                success: true,
                verifiedAtMs: 99,
                modelCount: 8,
                models: [{ id: 'abc-coder-v2' }, { id: 'abc-fast' }],
              },
            }
          default:
            return { ok: true, result: {} }
        }
      },
    ),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport

  const bridge = {
    request: vi.fn(
      async (
        route: { action: string },
        payload: { id?: string; config?: NexusProviderConfig },
      ) => {
        switch (route.action) {
          case 'list':
            return { configs, activeProviderId }
          case 'upsert':
            calls.upsert += 1
            upserts.push({ id: payload.id!, config: payload.config! })
            configs = { ...configs, [payload.id!]: payload.config! }
            return { ok: true, configs, activeProviderId }
          case 'remove': {
            calls.remove += 1
            const next = { ...configs }
            delete next[payload.id!]
            configs = next
            activeProviderId = undefined
            return { ok: true, configs, activeProviderId }
          }
          case 'setActive':
            activeProviderId = payload.id
            return { ok: true, configs, activeProviderId }
          default:
            return {}
        }
      },
    ),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge

  return {
    calls,
    upserts,
    verifiedProviderIds,
    verifyUpdates,
    verifyKeyProviderIds,
    transport,
    bridge,
  }
}

/** Host catalog WITHOUT the custom provider — the shell splices it in via
 *  `BrowserHostBridge.getModelCatalog`, which the settings page never calls. */
const builtInOnlyCatalog: BrowserLlmCatalog = {
  providers: [
    {
      id: 'openai',
      label: 'OpenAI',
      iconSvg: '',
      enabled: true,
      defaultModelId: 'gpt-x',
      models: [{ id: 'gpt-x', label: 'GPT X', enabled: true }],
    },
    // The backend execution slot. It must NOT appear as a selectable
    // "Custom endpoint" provider any more — the custom-provider flow replaced
    // it.
    {
      id: 'custom-openai',
      label: 'Custom (OpenAI-compatible)',
      iconSvg: '',
      enabled: false,
      models: [],
    },
  ],
}

describe('ModelsSection custom provider', () => {
  it('opens a configured custom provider in the custom editor, not the built-in form', async () => {
    const { calls, transport, bridge } = makeCustomProviderHarness()

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog: builtInOnlyCatalog, transport }),
      ),
    )
    await openProviderSettings(CUSTOM_ID)

    const nameInput = (await screen.findByTestId(
      'custom-provider-name',
    )) as HTMLInputElement
    expect(nameInput.value).toBe('ABC Provider')
    expect(
      (screen.getByTestId('custom-provider-base-url') as HTMLInputElement).value,
    ).toBe('https://api.abc.example/v1')
    // The configured model renders as a row with its limits summarised.
    expect(screen.getByTestId('custom-model-row-abc-coder-v2')).toBeTruthy()
    expect(screen.getByText(/256K context/)).toBeTruthy()
    // Custom providers are deletable, never "reset".
    expect(screen.getByTestId('custom-provider-delete')).toBeTruthy()
    // The built-in editor's fields are absent…
    expect(screen.queryByTestId('models-base-url')).toBeNull()
    // Auto-discovery fires when the editor opens on a valid base URL (the
    // auto-discover effect in ModelsSection.tsx) — and not before: the home
    // list selects nothing — so the harness sees one verify call. Custom providers still save EXPLICITLY (no
    // auto-connect debounce), so upsert remains 0.
    expect(calls.verify).toBe(1)
    expect(calls.upsert).toBe(0)
  })

  it('lays the two API-compatibility radios out on one row', async () => {
    // RadioGroup's base class is `grid`. tailwind-merge only drops a class from
    // the SAME group, so `flex-row` (flex-direction) never displaced `grid`
    // (display) — the two options rendered stacked, one per line. The override
    // has to say `flex` explicitly.
    const { transport, bridge } = makeCustomProviderHarness()

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog: builtInOnlyCatalog, transport }),
      ),
    )
    await openProviderSettings(CUSTOM_ID)

    const group = (await screen.findByTestId('custom-compat-openai')).closest(
      '[data-slot="radio-group"]',
    ) as HTMLElement | null
    expect(group).not.toBeNull()
    expect(group!.querySelector('[data-testid="custom-compat-anthropic"]')).not.toBeNull()
    const classes = group!.className.split(/\s+/)
    expect(classes).toContain('flex')
    expect(classes).toContain('flex-row')
    expect(classes).not.toContain('grid')
  })

  it('saves explicitly, persisting the custom marker and model list', async () => {
    const { calls, upserts, transport, bridge } = makeCustomProviderHarness()

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog: builtInOnlyCatalog, transport }),
      ),
    )
    await openProviderSettings(CUSTOM_ID)

    const submit = (await screen.findByTestId(
      'custom-provider-submit',
    )) as HTMLButtonElement
    // Nothing changed yet → Save changes is inert.
    expect(submit.disabled).toBe(true)

    fireEvent.change(screen.getByTestId('custom-provider-base-url'), {
      target: { value: 'https://api.abc.example/v2/' },
    })
    await waitFor(() => expect(submit.disabled).toBe(false))
    // Still no write until the user asks for one — no debounce auto-save.
    expect(calls.upsert).toBe(0)

    fireEvent.click(submit)
    await waitFor(() => expect(calls.upsert).toBe(1))
    expect(upserts[0].id).toBe(CUSTOM_ID)
    expect(upserts[0].config).toMatchObject({
      isCustomProvider: true,
      displayName: 'ABC Provider',
      apiCompatibility: 'openai',
      // Trailing slash normalised away.
      baseUrl: 'https://api.abc.example/v2',
      defaultModel: 'abc-coder-v2',
      enabledModels: ['abc-coder-v2'],
    })
    expect(upserts[0].config.customModels).toHaveLength(1)
  })

  it('starts a pre-filled OpenCode Zen draft from the dropdown and saves it with the typed key', async () => {
    zenSwitch.enabled = true
    const { upserts, verifyUpdates, transport, bridge } =
      makeCustomProviderHarness()

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog: builtInOnlyCatalog, transport }),
      ),
    )
    await addProviderFromMenu('models-add-opencode-zen')


    const nameInput = (await screen.findByTestId(
      'custom-provider-name',
    )) as HTMLInputElement
    await waitFor(() => expect(nameInput.value).toBe('OpenCode Zen'))
    expect(
      (screen.getByTestId('custom-provider-base-url') as HTMLInputElement).value,
    ).toBe('https://opencode.ai/zen/v1')
    expect(screen.getByTestId('custom-model-row-big-pickle')).toBeTruthy()
    expect(screen.getByTestId('custom-provider-opencode-zen-hint')).toBeTruthy()
    // The keyless draft's discovery probe goes out as OpenCode would: the
    // anonymous key and OpenCode's User-Agent, not the slot's stored one.
    await waitFor(() =>
      expect(verifyUpdates).toContainEqual({
        api_key: 'public',
        base_url: 'https://opencode.ai/zen/v1',
        user_agent: OPENCODE_ZEN_USER_AGENT,
      }),
    )

    fireEvent.change(screen.getByTestId('custom-provider-api-key'), {
      target: { value: 'zen-key' },
    })
    const submit = screen.getByTestId(
      'custom-provider-submit',
    ) as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)

    await waitFor(() => expect(upserts).toHaveLength(1))
    expect(upserts[0].id).not.toBe(CUSTOM_ID)
    expect(upserts[0].config).toMatchObject({
      isCustomProvider: true,
      displayName: 'OpenCode Zen',
      apiCompatibility: 'openai',
      baseUrl: 'https://opencode.ai/zen/v1',
      apiKey: 'zen-key',
      defaultModel: 'big-pickle',
      trust: 'untrusted',
    })
  })

  it('tests the connection through the dialect backend slot, never the custom id', async () => {
    const { calls, verifiedProviderIds, verifyUpdates, transport, bridge } =
      makeCustomProviderHarness()

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog: builtInOnlyCatalog, transport }),
      ),
    )
    await openProviderSettings(CUSTOM_ID)

    fireEvent.click(await screen.findByTestId('custom-provider-test'))

    await waitFor(() => expect(calls.verify).toBe(2))
    // The auto-discover effect already called verify once on mount; the "Test
    // connection" button triggers a second one. `custom-abc-provider` is not
    // constructible by the C++ provider factory; probing it directly would
    // always fail, so both calls go to the backend slot.
    expect(verifiedProviderIds).toEqual(['custom-openai', 'custom-openai'])
    // A non-Zen endpoint probes with the host default User-Agent, sent as ''
    // so the slot's stored one (another provider's) is not reused.
    for (const updates of verifyUpdates) {
      expect(updates.user_agent).toBe('')
    }
    await waitFor(() =>
      expect(
        screen.getByTestId('custom-provider-test-status').textContent,
      ).toMatch(/Connection successful/),
    )
  })

  it('probes a saved provider with its STORED key by naming the record', async () => {
    // The WebUI holds only `hasApiKey` for a saved record, and the probe is
    // addressed to the shared backend slot — whose stored key is not this
    // provider's. Before the fix the probe went out with api_key '' and no
    // record id, so the host could never find the right key.
    const { calls, verifiedProviderIds, verifyUpdates, verifyKeyProviderIds, transport, bridge } =
      makeCustomProviderHarness({ redactedKey: true })

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog: builtInOnlyCatalog, transport }),
      ),
    )
    await openProviderSettings(CUSTOM_ID)
    fireEvent.click(await screen.findByTestId('custom-provider-test'))

    // Both the auto-discover probe and "Test connection".
    await waitFor(() => expect(calls.verify).toBe(2))
    expect(verifiedProviderIds).toEqual(['custom-openai', 'custom-openai'])
    expect(verifyKeyProviderIds).toEqual([CUSTOM_ID, CUSTOM_ID])
    for (const updates of verifyUpdates) expect(updates.api_key).toBe('')

    // A key typed into the draft is probed as typed (the host uses the
    // record's key only when the draft's is empty).
    fireEvent.change(screen.getByTestId('custom-provider-api-key'), {
      target: { value: 'sk-new' },
    })
    fireEvent.click(screen.getByTestId('custom-provider-test'))
    await waitFor(() => expect(calls.verify).toBe(3))
    expect(verifyUpdates[2].api_key).toBe('sk-new')
  })

  it('names no key record while creating a provider', async () => {
    zenSwitch.enabled = true
    const { verifyUpdates, verifyKeyProviderIds, transport, bridge } =
      makeCustomProviderHarness()

    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog: builtInOnlyCatalog, transport }),
      ),
    )
    await addProviderFromMenu('models-add-opencode-zen')
    await waitFor(() =>
      expect(verifyUpdates).toContainEqual(
        expect.objectContaining({ api_key: 'public' }),
      ),
    )
    expect(verifyKeyProviderIds.every((id) => id === undefined)).toBe(true)
  })
})

/**
 * The home page: three built-ins in different states (`openai` configured, `anthropic` only broker-verified,
 * `gemini` not set up) plus a custom provider; "added" reads both sources and the Add menu offers the rest.
 */
const homeCatalog: BrowserLlmCatalog = {
  providers: [
    { id: 'openai', label: 'OpenAI', iconSvg: '', enabled: true, models: [] },
    { id: 'anthropic', label: 'Anthropic', iconSvg: '', enabled: true, models: [] },
    { id: 'gemini', label: 'Gemini', iconSvg: '', enabled: true, models: [] },
    // The backend execution slot is never a provider of its own.
    { id: 'custom-openai', label: 'Custom (OpenAI-compatible)', iconSvg: '', enabled: false, models: [] },
  ],
}

function makeHomeHarness(
  initialOrder: string[] = [],
  configOverrides: Record<string, NexusProviderConfig> = {},
  /** `providers.freshModelIds` answers by provider id (absent = a failure). */
  freshModelIds: Record<string, unknown> = {},
) {
  const calls = {
    verify: 0,
    remove: [] as string[],
    reset: [] as string[],
    setOrder: [] as string[][],
    setActive: [] as string[],
    fresh: [] as string[],
  }
  let order = initialOrder
  let anthropicVerified = true
  let configs: Record<string, NexusProviderConfig> = {
    openai: {
      hasApiKey: true,
      lastVerification: { providerId: 'openai', verifiedAtMs: 1 },
    },
    // A bare "Official connection" marker, written by ticking the box before
    // any key: NOT a setup. The quick picker leaves gemini out, so the list
    // must too — the user saw it listed while the picker showed nothing.
    gemini: { trust: 'trusted' },
    [CUSTOM_ID]: {
      isCustomProvider: true,
      displayName: 'ABC Provider',
      providerIcon: 'generic',
      apiCompatibility: 'openai',
      baseUrl: 'https://api.abc.example/v1',
      defaultModel: 'abc-coder-v2',
      customModels: [
        {
          modelId: 'abc-coder-v2',
          contextWindow: 262144,
          maxOutputTokens: 65536,
        },
      ],
    },
    ...configOverrides,
  }
  let activeProviderId = 'openai'

  const transport = {
    request: vi.fn(
      async (req: { route: { action: string }; payload: { providerId?: string } }) => {
        switch (req.route.action) {
          case 'list':
            return {
              ok: true,
              result: {
                providers: [
                  { id: 'openai', name: 'OpenAI', type: 'cloud', authMode: 'apiKey', hasDefaultBaseUrl: true },
                  {
                    id: 'anthropic',
                    name: 'Anthropic',
                    type: 'cloud',
                    authMode: 'apiKey',
                    hasDefaultBaseUrl: true,
                    isVerified: anthropicVerified,
                    hasStoredApiKey: anthropicVerified,
                  },
                  { id: 'gemini', name: 'Gemini', type: 'cloud', authMode: 'apiKey', hasDefaultBaseUrl: true },
                ],
              },
            }
          case 'reset':
            calls.reset.push(req.payload.providerId!)
            if (req.payload.providerId === 'anthropic') anthropicVerified = false
            return { ok: true, result: { success: true } }
          case 'verify':
            calls.verify += 1
            return { ok: true, result: { success: true, models: [] } }
          default:
            return { ok: true, result: {} }
        }
      },
    ),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport

  // `holdLists()` parks every later `providers.list` AFTER it took its
  // snapshot, until the returned release runs — a read in flight while a
  // `providers.changed` lands.
  let listHold: Promise<void> | null = null
  const holdLists = () => {
    let release!: () => void
    listHold = new Promise<void>(r => {
      release = r
    })
    return () => {
      listHold = null
      release()
    }
  }
  let onEvent: ((envelope: unknown) => void) | null = null
  const emitChanged = (payload: {
    order?: string[]
    reason?: string
  }) => {
    if (payload.order) order = payload.order
    onEvent?.({
      route: { capability: 'providers', action: 'changed' },
      payload: { configs, activeProviderId, ...payload },
    })
  }

  const bridge = {
    request: vi.fn(
      async (route: { action: string }, payload: { id?: string; order?: string[] }) => {
        switch (route.action) {
          case 'list': {
            const snapshot = { configs, activeProviderId, order }
            if (listHold) await listHold
            return snapshot
          }
          case 'setOrder':
            calls.setOrder.push(payload.order!)
            order = payload.order!
            return { ok: true, order }
          case 'setActive':
            calls.setActive.push(payload.id!)
            activeProviderId = payload.id!
            return { ok: true, configs, activeProviderId }
          case 'remove': {
            calls.remove.push(payload.id!)
            const next = { ...configs }
            delete next[payload.id!]
            configs = next
            return { ok: true, configs, activeProviderId }
          }
          case 'freshModelIds':
            calls.fresh.push(payload.id!)
            return freshModelIds[payload.id!] ?? { ok: false, error: 'unreachable' }
          default:
            return { ok: true, configs, activeProviderId }
        }
      },
    ),
    subscribeEvents: (listener: (envelope: unknown) => void) => {
      onEvent = listener
      return () => {
        onEvent = null
      }
    },
  } as unknown as NexusSettingsBridge

  return { calls, transport, bridge, holdLists, emitChanged }
}

function renderHome(
  h: ReturnType<typeof makeHomeHarness>,
  catalog: BrowserLlmCatalog = homeCatalog,
) {
  render(
    createElement(
      SettingsBridgeContext.Provider,
      { value: h.bridge },
      createElement(ModelsSection, { catalog, transport: h.transport }),
    ),
  )
}

/** Open a home-list row's "⋯" menu. */
async function openRowMenu(id: string) {
  fireEvent.keyDown(await screen.findByTestId(`models-provider-menu-${id}`), {
    key: 'Enter',
  })
  await screen.findByTestId(`models-provider-delete-${id}`)
}

/** Open the Add menu and return the test ids of what it offers. */
async function readAddMenu(): Promise<string[]> {
  fireEvent.keyDown(await screen.findByTestId('models-add-provider'), { key: 'Enter' })
  await screen.findByTestId('models-add-custom-provider')
  return Array.from(document.querySelectorAll('[role="option"]')).map(
    el => el.getAttribute('data-testid') ?? '',
  )
}

describe('ModelsSection home page', () => {
  it('lists the added providers (settings.json AND broker-only) and opens on no editor', async () => {
    const h = makeHomeHarness()
    renderHome(h)

    // The broker-only provider has to wait for the registry round-trip.
    await screen.findByTestId('models-provider-row-anthropic')
    expect(screen.getByTestId('models-provider-row-openai')).toBeTruthy()
    expect(screen.getByTestId(`models-provider-row-${CUSTOM_ID}`)).toBeTruthy()
    // Not set up anywhere → not on the list; the backend slot never is.
    expect(screen.queryByTestId('models-provider-row-gemini')).toBeNull()
    expect(screen.queryByTestId('models-provider-row-custom-openai')).toBeNull()

    // Every row carries Settings and a "⋯" menu — and no Remove button of
    // its own: Remove lives in the menu, so no row is a red trash can.
    for (const id of ['openai', 'anthropic', CUSTOM_ID]) {
      expect(screen.getByTestId(`models-provider-settings-${id}`)).toBeTruthy()
      expect(screen.getByTestId(`models-provider-menu-${id}`)).toBeTruthy()
      expect(screen.queryByTestId(`models-provider-delete-${id}`)).toBeNull()
    }
    // The active provider is marked; a connected built-in says so, quietly —
    // muted text, not a coloured badge.
    expect(screen.getByTestId('models-provider-default-openai').textContent).toBe('Default')
    const status = screen.getByTestId('models-provider-status-anthropic')
    expect(status.dataset.status).toBe('connected')
    expect(status.textContent).toBe('Connected')
    expect(status.hasAttribute('data-variant')).toBe(false)
    // Each row says how it connects; a custom provider carries no status.
    expect(screen.getByTestId('models-provider-kind-openai').textContent).toBe('API key')
    expect(screen.getByTestId(`models-provider-kind-${CUSTOM_ID}`).textContent).toBe(
      'Custom endpoint',
    )
    expect(screen.queryByTestId(`models-provider-status-${CUSTOM_ID}`)).toBeNull()
    // One heading: the page title, with no second "Your providers" over the list.
    expect(screen.getByText('Model Providers')).toBeTruthy()
    expect(screen.queryByText('Your providers')).toBeNull()

    // Home opens NO editor — and so runs no custom provider's discovery probe.
    expect(screen.queryByTestId('models-base-url')).toBeNull()
    expect(screen.queryByTestId('custom-provider-name')).toBeNull()
    expect(h.calls.verify).toBe(0)
  })

  it('offers only the built-ins not yet added, and always the two create actions', async () => {
    zenSwitch.enabled = true
    const h = makeHomeHarness()
    renderHome(h)
    await screen.findByTestId('models-provider-row-anthropic')

    expect(await readAddMenu()).toEqual([
      'models-provider-select-option-gemini',
      // A custom provider already exists, and adding another is still offered.
      'models-add-custom-provider',
      'models-add-opencode-zen',
    ])
  })

  it('puts the gateways (OpenRouter, Vercel AI Gateway) in their own section, after a separator', async () => {
    const h = makeHomeHarness()
    const catalog: BrowserLlmCatalog = {
      providers: [
        ...homeCatalog.providers,
        { id: 'openrouter', label: 'OpenRouter', iconSvg: '', enabled: false, models: [] },
        { id: 'vercel-ai-gateway', label: 'Vercel AI Gateway', iconSvg: '', enabled: false, models: [] },
      ],
    }
    renderHome(h, catalog)
    await screen.findByTestId('models-provider-row-anthropic')

    expect(await readAddMenu()).toEqual([
      'models-provider-select-option-gemini',
      'models-provider-select-option-openrouter',
      'models-provider-select-option-vercel-ai-gateway',
      'models-add-custom-provider',
    ])
    const vendors = screen.getByTestId('models-add-group-vendors')
    const gateways = screen.getByTestId('models-add-group-gateways')
    expect(vendors.textContent).toContain('Gemini')
    expect(vendors.textContent).not.toContain('OpenRouter')
    expect(gateways.textContent).toContain('Gateways')
    expect(gateways.textContent).toContain('OpenRouter')
    expect(gateways.textContent).toContain('Vercel AI Gateway')
    expect(gateways.previousElementSibling?.className).toContain('bg-border')
  })

  it('offers no OpenCode Zen row while Zen is switched off', async () => {
    const h = makeHomeHarness()
    renderHome(h)
    await screen.findByTestId('models-provider-row-anthropic')

    expect(await readAddMenu()).toEqual([
      'models-provider-select-option-gemini',
      'models-add-custom-provider',
    ])
  })

  it('opens an editor with no provider switcher, and goes back to the list', async () => {
    const h = makeHomeHarness()
    renderHome(h)

    await openProviderSettings('openai')
    await screen.findByTestId('models-base-url')
    expect(screen.getByTestId('models-editing-provider').textContent).toContain('OpenAI')
    // Neither the old switcher nor the home list is reachable from here.
    expect(screen.queryByTestId('models-provider-select')).toBeNull()
    expect(screen.queryByTestId('models-add-provider')).toBeNull()
    expect(screen.queryByTestId('models-provider-list')).toBeNull()

    // The provider name IS the heading: no "Provider connection" title over
    // it, and the way back reads "Providers".
    expect(screen.getByTestId('models-editing-provider').tagName).toBe('H1')
    expect(screen.queryByText('Model Providers')).toBeNull()
    expect(screen.getByTestId('models-back-to-providers').textContent).toBe('Providers')

    // A stored key is said ONCE: "Saved" beside the label, a replace
    // placeholder, one plain hint — and never "verified".
    expect(screen.getByTestId('models-api-key-saved').textContent).toBe('Saved')
    expect(
      (screen.getByTestId('models-api-key') as HTMLInputElement).placeholder,
    ).toBe('Enter a new key to replace the saved key')
    expect(screen.getByText('Stored securely on this device.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/verified key/i)

    fireEvent.click(screen.getByTestId('models-back-to-providers'))
    await screen.findByTestId('models-provider-list')
    expect(screen.getByText('Model Providers')).toBeTruthy()
    expect(screen.queryByTestId('models-base-url')).toBeNull()

    // A built-in picked from the Add menu opens the same editor.
    await addProviderFromMenu('models-provider-select-option-gemini')
    expect(
      (await screen.findByTestId('models-editing-provider')).textContent,
    ).toContain('Gemini')
    await screen.findByTestId('models-api-key')
    // No key stored for it yet: no "Saved" marker.
    expect(screen.queryByTestId('models-api-key-saved')).toBeNull()
  })

  it('removes a built-in from the list: broker reset + settings removal, and it is offered again', async () => {
    const h = makeHomeHarness()
    renderHome(h)

    await openRowMenu('anthropic')
    fireEvent.click(screen.getByTestId('models-provider-delete-anthropic'))
    fireEvent.click(await screen.findByTestId('models-provider-remove-confirm'))

    await waitFor(() =>
      expect(screen.queryByTestId('models-provider-row-anthropic')).toBeNull(),
    )
    expect(h.calls.reset).toEqual(['anthropic'])
    expect(h.calls.remove).toEqual(['anthropic'])
    expect(await readAddMenu()).toContain('models-provider-select-option-anthropic')
  })

  it('deletes a custom provider from the list', async () => {
    const h = makeHomeHarness()
    renderHome(h)

    await openRowMenu(CUSTOM_ID)
    fireEvent.click(screen.getByTestId(`models-provider-delete-${CUSTOM_ID}`))
    // The custom wording: the whole provider goes, not just its key.
    await screen.findByText('Delete "ABC Provider"?')
    fireEvent.click(screen.getByTestId('custom-provider-delete-confirm'))

    await waitFor(() =>
      expect(screen.queryByTestId(`models-provider-row-${CUSTOM_ID}`)).toBeNull(),
    )
    expect(h.calls.remove).toEqual([CUSTOM_ID])
    // Custom providers are never offered back as a built-in row.
    expect(await readAddMenu()).not.toContain(
      `models-provider-select-option-${CUSTOM_ID}`,
    )
  })

  it('shows Settings as an icon button with a tooltip, not a text label or a menu item', async () => {
    const h = makeHomeHarness()
    renderHome(h)

    const settings = await screen.findByTestId('models-provider-settings-anthropic')
    expect(settings.textContent).toBe('')
    expect(settings.querySelector('svg')).toBeTruthy()
    expect(settings.getAttribute('title')).toBe('Anthropic settings')
    expect(settings.getAttribute('aria-label')).toBe('Anthropic settings')

    // The "⋯" menu no longer repeats it.
    await openRowMenu('anthropic')
    expect(screen.queryByTestId('models-provider-menu-settings-anthropic')).toBeNull()
  })

  it('sets a provider as default from its menu; the default row offers it disabled', async () => {
    const h = makeHomeHarness()
    renderHome(h)

    await openRowMenu('openai')
    const current = screen.getByTestId('models-provider-set-default-openai')
    expect(current.textContent).toBe('Default provider')
    expect(current.hasAttribute('data-disabled')).toBe(true)
    fireEvent.keyDown(current, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByTestId('models-provider-set-default-openai')).toBeNull(),
    )

    await openRowMenu('anthropic')
    const item = screen.getByTestId('models-provider-set-default-anthropic')
    expect(item.textContent).toBe('Set as default')
    fireEvent.click(item)

    await waitFor(() => expect(h.calls.setActive).toEqual(['anthropic']))
    await screen.findByTestId('models-provider-default-anthropic')
    expect(screen.queryByTestId('models-provider-default-openai')).toBeNull()
    // No editor was opened to get there.
    expect(screen.queryByTestId('models-base-url')).toBeNull()
  })

  it('flags a built-in that is not connected, and will not make it the default', async () => {
    // A key saved but never verified: added, not connected.
    const h = makeHomeHarness([], { openai: { hasApiKey: true } })
    renderHome(h)

    const status = await screen.findByTestId('models-provider-status-openai')
    expect(status.dataset.status).toBe('not-connected')
    expect(status.textContent).toBe('Not connected')

    await openRowMenu('anthropic')
    fireEvent.click(screen.getByTestId('models-provider-set-default-anthropic'))
    await waitFor(() => expect(h.calls.setActive).toEqual(['anthropic']))
    await screen.findByTestId('models-provider-default-anthropic')

    await openRowMenu('openai')
    const item = screen.getByTestId('models-provider-set-default-openai')
    expect(item.textContent).toBe('Set as default')
    expect(item.hasAttribute('data-disabled')).toBe(true)
    fireEvent.click(item)
    expect(h.calls.setActive).toEqual(['anthropic'])
  })

  it('guards the way back from a dirty custom draft, and Discard lands on the list', async () => {
    const h = makeHomeHarness()
    renderHome(h)

    await openProviderSettings(CUSTOM_ID)
    fireEvent.change(await screen.findByTestId('custom-provider-name'), {
      target: { value: 'ABC Renamed' },
    })

    fireEvent.click(screen.getByTestId('models-back-to-providers'))
    fireEvent.click(await screen.findByTestId('custom-provider-keep-editing'))
    expect(
      (screen.getByTestId('custom-provider-name') as HTMLInputElement).value,
    ).toBe('ABC Renamed')

    fireEvent.click(screen.getByTestId('models-back-to-providers'))
    fireEvent.click(await screen.findByTestId('custom-provider-discard-confirm'))
    await screen.findByTestId('models-provider-list')

    // Reopening starts from the stored record, not the discarded edit.
    await openProviderSettings(CUSTOM_ID)
    await waitFor(() =>
      expect(
        (screen.getByTestId('custom-provider-name') as HTMLInputElement).value,
      ).toBe('ABC Provider'),
    )
  })

  // The background updater reloads a HIDDEN page (glic/unsavedEditsGate.ts);
  // a half-filled provider form lives only in this page, so a dirty editor
  // holds the reload and a clean one releases it.
  it('holds the background updater’s reload while a custom draft is dirty', async () => {
    const h = makeHomeHarness()
    renderHome(h)

    await openProviderSettings(CUSTOM_ID)
    const name = (await screen.findByTestId('custom-provider-name')) as HTMLInputElement
    await waitFor(() => expect(name.value).toBe('ABC Provider'))
    expect(hasUnsavedEdits()).toBe(false)

    fireEvent.change(name, { target: { value: 'ABC Renamed' } })
    expect(hasUnsavedEdits()).toBe(true)
    // Typed back to the stored value: nothing left to lose.
    fireEvent.change(name, { target: { value: 'ABC Provider' } })
    expect(hasUnsavedEdits()).toBe(false)
  })
})

/**
 * Reordering the home list — by DRAG only (there are no up/down buttons), with
 * the arrow keys on the grip as the pointer-free path. The stored order is
 * what the quick model picker follows (`provider-order.test.ts`).
 */
describe('ModelsSection provider order', () => {
  const rowIds = () =>
    Array.from(document.querySelectorAll('[data-testid^="models-provider-row-"]')).map(
      el => el.getAttribute('data-testid')!.replace('models-provider-row-', ''),
    )

  it('lists the rows in the stored order', async () => {
    renderHome(makeHomeHarness([CUSTOM_ID, 'anthropic']))
    await screen.findByTestId('models-provider-row-anthropic')
    expect(rowIds()).toEqual([CUSTOM_ID, 'anthropic', 'openai'])
  })

  /**
   * The drag is pointer-driven from the grip (native HTML5 drag-and-drop was
   * unreliable inside the embedded guest page — the user's first try did not
   * move anything). The grip holds pointer capture, so the target row is found
   * from the pointer position: stubbed here, since the test DOM has no layout.
   */
  const pointerOver = (targetId: string) =>
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(
      screen.getByTestId(`models-provider-row-${targetId}`),
    )

  it('drags a row by its grip, moves it live, and stores the order on release', async () => {
    const h = makeHomeHarness()
    renderHome(h)
    await screen.findByTestId('models-provider-row-anthropic')
    expect(rowIds()).toEqual(['openai', 'anthropic', CUSTOM_ID])

    const grip = screen.getByTestId(`models-provider-grip-${CUSTOM_ID}`)
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1 })
    const spy = pointerOver('openai')
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5, clientY: 5 })
    // The row moves under the pointer before anything is written.
    expect(rowIds()).toEqual([CUSTOM_ID, 'openai', 'anthropic'])
    expect(h.calls.setOrder).toEqual([])

    fireEvent.pointerUp(grip, { pointerId: 1 })
    spy.mockRestore()
    await waitFor(() =>
      expect(h.calls.setOrder).toEqual([[CUSTOM_ID, 'openai', 'anthropic']]),
    )
    expect(rowIds()).toEqual([CUSTOM_ID, 'openai', 'anthropic'])
  })

  it('writes nothing when the pointer is cancelled mid-drag', async () => {
    const h = makeHomeHarness()
    renderHome(h)
    await screen.findByTestId('models-provider-row-anthropic')

    const grip = screen.getByTestId(`models-provider-grip-${CUSTOM_ID}`)
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1 })
    const spy = pointerOver('openai')
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5, clientY: 5 })
    fireEvent.pointerCancel(grip, { pointerId: 1 })
    spy.mockRestore()

    expect(rowIds()).toEqual(['openai', 'anthropic', CUSTOM_ID])
    expect(h.calls.setOrder).toEqual([])
  })

  it('writes nothing for a press and release that moved nothing, with no stored order', async () => {
    // No `providers.order` yet: writing the list as shown would freeze
    // today's order for a click on the grip.
    const h = makeHomeHarness()
    renderHome(h)
    await screen.findByTestId('models-provider-row-anthropic')

    const grip = screen.getByTestId(`models-provider-grip-${CUSTOM_ID}`)
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1 })
    fireEvent.pointerUp(grip, { pointerId: 1 })
    // …nor for a drag that ends back where it started.
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1 })
    let spy = pointerOver('openai')
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5, clientY: 5 })
    spy.mockRestore()
    spy = pointerOver('anthropic')
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5, clientY: 50 })
    spy.mockRestore()
    spy = pointerOver(CUSTOM_ID)
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5, clientY: 90 })
    spy.mockRestore()
    expect(rowIds()).toEqual(['openai', 'anthropic', CUSTOM_ID])
    fireEvent.pointerUp(grip, { pointerId: 1 })

    await new Promise(r => setTimeout(r, 0))
    expect(h.calls.setOrder).toEqual([])
    expect(document.querySelector('[data-provider-dragging]')).toBeNull()
  })

  it('finishes a drag released away from the grip, which may have lost capture', async () => {
    // Moving a row DOWN re-inserts its own node, and Chromium then releases
    // the grip's pointer capture: the release lands on whatever is under the
    // pointer, not on the grip.
    const h = makeHomeHarness()
    renderHome(h)
    await screen.findByTestId('models-provider-row-anthropic')

    const grip = screen.getByTestId('models-provider-grip-openai')
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1 })
    const spy = pointerOver('anthropic')
    const elsewhere = screen.getByTestId('models-provider-row-anthropic')
    fireEvent.pointerMove(elsewhere, { pointerId: 1, clientX: 5, clientY: 50 })
    expect(rowIds()).toEqual(['anthropic', 'openai', CUSTOM_ID])
    expect(
      screen.getByTestId('models-provider-row-openai').hasAttribute('data-provider-dragging'),
    ).toBe(true)
    fireEvent.pointerUp(elsewhere, { pointerId: 1 })
    spy.mockRestore()

    await waitFor(() =>
      expect(h.calls.setOrder).toEqual([['anthropic', 'openai', CUSTOM_ID]]),
    )
    expect(document.querySelector('[data-provider-dragging]')).toBeNull()
  })

  it('moves a row once for several moves over the same row before the layout catches up', async () => {
    // Under load several pointermoves can be dispatched before the list
    // re-lays out, so each one hit-tests the same row at its old place.
    const h = makeHomeHarness()
    renderHome(h)
    await screen.findByTestId(`models-provider-row-${CUSTOM_ID}`)
    const [top, middle] = rowIds()

    const grip = screen.getByTestId(`models-provider-grip-${top}`)
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1 })
    const spy = pointerOver(middle!)
    for (let i = 0; i < 4; i++) {
      fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5 + i, clientY: 50 })
    }
    expect(rowIds()).toEqual([middle, top, CUSTOM_ID])
    fireEvent.pointerUp(grip, { pointerId: 1 })
    spy.mockRestore()

    await waitFor(() => expect(h.calls.setOrder).toEqual([[middle, top, CUSTOM_ID]]))
  })

  it('moves a row back over the row it passed once the pointer has been over its own row', async () => {
    const h = makeHomeHarness()
    renderHome(h)
    await screen.findByTestId(`models-provider-row-${CUSTOM_ID}`)
    const [top, middle] = rowIds()

    const grip = screen.getByTestId(`models-provider-grip-${top}`)
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1 })
    for (const [over, y] of [[middle!, 50], [top!, 50], [middle!, 5]] as const) {
      const spy = pointerOver(over)
      fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5, clientY: y })
      spy.mockRestore()
    }
    expect(rowIds()).toEqual([top, middle, CUSTOM_ID])
    fireEvent.pointerUp(grip, { pointerId: 1 })

    await new Promise(r => setTimeout(r, 0))
    expect(h.calls.setOrder).toEqual([])
  })

  it('does not pick a row up from anywhere but its grip', async () => {
    const h = makeHomeHarness()
    renderHome(h)
    await screen.findByTestId('models-provider-row-anthropic')

    // A press and a move on the row's Settings button: nothing moves.
    const settings = screen.getByTestId('models-provider-settings-anthropic')
    fireEvent.pointerDown(settings, { button: 0, pointerId: 1 })
    const spy = pointerOver('openai')
    fireEvent.pointerMove(settings, { pointerId: 1, clientX: 5, clientY: 5 })
    fireEvent.pointerUp(settings, { pointerId: 1 })
    spy.mockRestore()

    expect(rowIds()).toEqual(['openai', 'anthropic', CUSTOM_ID])
    expect(h.calls.setOrder).toEqual([])
  })

  // A `providers.list` answered after a newer `providers.changed` used to
  // put the older order back on screen.
  it('keeps a providers.changed order over a list read it overtook', async () => {
    const h = makeHomeHarness()
    const release = h.holdLists()
    renderHome(h)
    await waitFor(() =>
      expect(
        (h.bridge.request as ReturnType<typeof vi.fn>).mock.calls.some(
          c => (c[0] as { action: string }).action === 'list',
        ),
      ).toBe(true),
    )
    // The read went out with no stored order; a reorder elsewhere lands first.
    act(() => h.emitChanged({ order: [CUSTOM_ID, 'anthropic', 'openai'], reason: 'order' }))
    release()
    await screen.findByTestId('models-provider-row-anthropic')
    await new Promise(r => setTimeout(r, 0))
    expect(rowIds()).toEqual([CUSTOM_ID, 'anthropic', 'openai'])
  })

  // The host echoes every order write as a `providers.changed`. The page
  // keeps a newer written order on screen when an older write's echo
  // arrives, even mid-drag: a drop compares its order against the list, so
  // a list moved back to the older order would make the drop look current
  // and write nothing.
  it('keeps a drop whose order an older write echoed late would have put back on screen', async () => {
    const h = makeHomeHarness()
    renderHome(h)
    const [idA, idB] = homeCatalog.providers.map(p => p.id)
    await screen.findByTestId(`models-provider-row-${idB}`)
    expect(rowIds()).toEqual([idA, idB, CUSTOM_ID])

    const drag = async (id: string, onto: string) => {
      const grip = screen.getByTestId(`models-provider-grip-${id}`)
      fireEvent.pointerDown(grip, { button: 0, pointerId: 1 })
      const spy = pointerOver(onto)
      fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5, clientY: 5 })
      spy.mockRestore()
      return grip
    }
    const drop = (grip: HTMLElement) => fireEvent.pointerUp(grip, { pointerId: 1 })

    // Two drags, neither echoed yet.
    drop(await drag(idB, idA))
    const first = [idB, idA, CUSTOM_ID]
    await waitFor(() => expect(h.calls.setOrder).toEqual([first]))
    drop(await drag(idA, idB))
    const second = [idA, idB, CUSTOM_ID]
    await waitFor(() => expect(h.calls.setOrder).toEqual([first, second]))

    // A third drag back to the first order; the first write's echo lands
    // while it is in flight.
    const grip = await drag(idA, idB)
    expect(rowIds()).toEqual(first)
    act(() => h.emitChanged({ order: first, reason: 'order' }))
    drop(grip)
    await waitFor(() => expect(h.calls.setOrder).toEqual([first, second, first]))
    expect(rowIds()).toEqual(first)

    // The second write's echo is older than what the list shows too.
    act(() => h.emitChanged({ order: second, reason: 'order' }))
    expect(rowIds()).toEqual(first)
    // The third's settles it…
    act(() => h.emitChanged({ order: first, reason: 'order' }))
    expect(rowIds()).toEqual(first)
    // …and an order written elsewhere is shown again.
    const elsewhere = [CUSTOM_ID, idB, idA]
    act(() => h.emitChanged({ order: elsewhere, reason: 'order' }))
    expect(rowIds()).toEqual(elsewhere)
    expect(h.calls.setOrder).toHaveLength(3)
  })

  // Drag, drag back, drag again writes [A, B, A]; the echoes arrive in write
  // order. The first echo is A's OLDEST write, not its newest: reading it as
  // the newest would settle the list at once, and B's echo would then pass
  // as another surface's order and move the list back to B.
  it('settles an echo against the oldest equal write', () => {
    const a = ['a', 'b']
    const b = ['b', 'a']
    const written = [a, b, a]
    expect(settleEchoedOrder(written, a)).toBe(false)
    expect(written).toEqual([b, a])
    expect(settleEchoedOrder(written, b)).toBe(false)
    expect(written).toEqual([a])
    expect(settleEchoedOrder(written, a)).toBe(true)
    expect(written).toEqual([])
    // Nothing written: any order is another surface's and shows.
    expect(settleEchoedOrder(written, b)).toBe(true)
  })

  it('shows no order a write of this page has not settled, until its echo arrives', () => {
    const a = ['a', 'b', 'c']
    const stored = ['c', 'b', 'a']
    const written = [a]
    // A change of something else carries the stored order from before the write.
    expect(settleEchoedOrder(written, stored)).toBe(false)
    expect(written).toEqual([a])
    expect(settleEchoedOrder(written, a)).toBe(true)
    expect(settleEchoedOrder(written, stored)).toBe(true)
  })

  it('keeps a drop on screen when another change lands before its echo', async () => {
    const h = makeHomeHarness()
    renderHome(h)
    const [idA, idB] = homeCatalog.providers.map(p => p.id)
    await screen.findByTestId(`models-provider-row-${idB}`)
    const before = [idA, idB, CUSTOM_ID]
    expect(rowIds()).toEqual(before)

    const grip = screen.getByTestId(`models-provider-grip-${idB}`)
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1 })
    const spy = pointerOver(idA)
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 5, clientY: 5 })
    spy.mockRestore()
    fireEvent.pointerUp(grip, { pointerId: 1 })
    const dropped = [idB, idA, CUSTOM_ID]
    await waitFor(() => expect(h.calls.setOrder).toEqual([dropped]))

    // A config save elsewhere fans out the order stored before the drop.
    act(() => h.emitChanged({ order: before }))
    expect(rowIds()).toEqual(dropped)
    act(() => h.emitChanged({ order: dropped, reason: 'order' }))
    expect(rowIds()).toEqual(dropped)
    act(() => h.emitChanged({ order: before, reason: 'order' }))
    expect(rowIds()).toEqual(before)
  })

  // H5: holding or tapping an arrow is one gesture — one write, not one per
  // keypress (each write fans `providers.changed` out to every surface).
  it('writes an arrow-key gesture once, when the keys go still', async () => {
    const h = makeHomeHarness()
    renderHome(h)
    await screen.findByTestId('models-provider-row-anthropic')

    const grip = () => screen.getByTestId(`models-provider-grip-${CUSTOM_ID}`)
    fireEvent.keyDown(grip(), { key: 'ArrowUp' })
    fireEvent.keyDown(grip(), { key: 'ArrowUp' })
    // The row moves at once…
    expect(rowIds()).toEqual([CUSTOM_ID, 'openai', 'anthropic'])
    // …and the order is written once, for the whole gesture.
    await waitFor(() =>
      expect(h.calls.setOrder).toEqual([[CUSTOM_ID, 'openai', 'anthropic']]),
    )
    await new Promise(r => setTimeout(r, 450))
    expect(h.calls.setOrder).toHaveLength(1)
  })

  it('writes a pending arrow-key order when the grip loses focus, and nothing for a round trip', async () => {
    const h = makeHomeHarness()
    renderHome(h)
    await screen.findByTestId('models-provider-row-anthropic')

    const grip = () => screen.getByTestId('models-provider-grip-anthropic')
    // Up then down: back where it began — nothing to write.
    fireEvent.keyDown(grip(), { key: 'ArrowUp' })
    fireEvent.keyDown(grip(), { key: 'ArrowDown' })
    fireEvent.blur(grip())
    expect(h.calls.setOrder).toEqual([])

    fireEvent.keyDown(grip(), { key: 'ArrowUp' })
    fireEvent.blur(grip())
    // Written on blur, without waiting for the keys to go still.
    expect(h.calls.setOrder).toEqual([['anthropic', 'openai', CUSTOM_ID]])
  })

  it('moves a row with the arrow keys on its grip', async () => {
    const h = makeHomeHarness()
    renderHome(h)
    await screen.findByTestId('models-provider-row-anthropic')

    fireEvent.keyDown(screen.getByTestId('models-provider-grip-anthropic'), {
      key: 'ArrowUp',
    })
    await waitFor(() =>
      expect(h.calls.setOrder).toEqual([['anthropic', 'openai', CUSTOM_ID]]),
    )
    // Already first: another ArrowUp writes nothing.
    fireEvent.keyDown(screen.getByTestId('models-provider-grip-anthropic'), {
      key: 'ArrowUp',
    })
    expect(h.calls.setOrder).toHaveLength(1)
  })
})

/**
 * The Models page hosts Session models as its second group (`footer`). It is
 * about choosing among the added providers' models, so it shows only on the
 * home list and only once a provider is added — never under an empty list,
 * and never inside one provider's editor.
 */
describe('ModelsSection footer (Session models group)', () => {
  const footer = createElement('div', { 'data-testid': 'models-footer' })

  it('shows under a non-empty provider list and hides inside the editor', async () => {
    const h = makeHomeHarness()
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: h.bridge },
        createElement(ModelsSection, { catalog: homeCatalog, transport: h.transport, footer }),
      ),
    )
    await screen.findByTestId('models-provider-row-openai')
    expect(screen.getByTestId('models-footer')).toBeTruthy()

    await openProviderSettings('openai')
    await screen.findByTestId('models-base-url')
    expect(screen.queryByTestId('models-footer')).toBeNull()
  })

  it('stays hidden while no provider is added', async () => {
    const { bridge, transport } = makeHarness()
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport, footer }),
      ),
    )
    await screen.findByTestId('models-provider-list-empty')
    expect(screen.queryByTestId('models-footer')).toBeNull()
  })
})

// The home page's per-row model count: the picker's models for the provider,
// checked against the provider's listing fetched EACH TIME the home page
// shows; red only when that fresh listing confirmed none of them.
describe('ModelsSection home page — available model counts', () => {
  const countCatalog: BrowserLlmCatalog = {
    providers: [
      {
        id: 'openai', label: 'OpenAI', iconSvg: '', enabled: true,
        models: [
          { id: 'gpt-6-astra', label: 'GPT-6 Astra', enabled: true },
          { id: 'gpt-6-sol', label: 'GPT-6 Sol', enabled: true },
          { id: 'gpt-old', label: 'Old', enabled: false },
        ],
      },
      {
        id: 'anthropic', label: 'Anthropic', iconSvg: '', enabled: true,
        models: [{ id: 'claude-haiku-4-5', label: 'Haiku', enabled: true }],
      },
      { id: 'gemini', label: 'Gemini', iconSvg: '', enabled: true, models: [] },
      {
        id: CUSTOM_ID, label: 'ABC Provider', iconSvg: '', enabled: true,
        models: [{ id: 'abc-coder-v2', label: 'ABC Coder', enabled: true }],
      },
    ],
  }
  const count = (id: string) => screen.getByTestId(`models-provider-models-${id}`)

  it('counts what the fresh listing still has; red only for a CONFIRMED zero', async () => {
    const h = makeHomeHarness([], {}, {
      // One of the two picker models is still listed.
      openai: { ok: true, ids: ['gpt-6-astra', 'gpt-7'] },
      // A fresh listing without the curated model: confirmed gone.
      anthropic: { ok: true, ids: ['claude-opus-5'] },
      // CUSTOM_ID: the fetch fails → the picker's own count, unconfirmed.
    })
    renderHome(h, countCatalog)
    await screen.findByTestId('models-provider-row-anthropic')
    await waitFor(() => expect(count('anthropic').dataset.confirmed).toBe('true'))
    await waitFor(() => expect(count('openai').dataset.confirmed).toBe('true'))

    expect(count('openai').textContent).toBe('1 model available')
    expect(count('openai').className).not.toContain('text-destructive')

    expect(count('anthropic').textContent).toBe('0 models available')
    expect(count('anthropic').className).toContain('text-destructive')
    expect(count('anthropic').getAttribute('title'))
      .toBe("The provider's latest model list no longer includes any of these models.")

    expect(count(CUSTOM_ID).dataset.confirmed).toBe('false')
    expect(count(CUSTOM_ID).textContent).toBe('1 model available')
    expect(count(CUSTOM_ID).className).not.toContain('text-destructive')
    expect([...h.calls.fresh].sort()).toEqual(['anthropic', CUSTOM_ID, 'openai'].sort())
  })

  it('a zero the listing did not confirm is never red (failed or empty listing)', async () => {
    const h = makeHomeHarness([], {}, {
      openai: { ok: true, ids: [] },
      anthropic: { ok: false, error: 'HTTP 503' },
    })
    renderHome(h, {
      providers: countCatalog.providers.map(p => (p.id === 'anthropic' ? { ...p, models: [] } : p)),
    })
    await screen.findByTestId('models-provider-row-anthropic')
    await waitFor(() => expect(h.calls.fresh).toContain('anthropic'))
    expect(count('anthropic').textContent).toBe('0 models available')
    expect(count('anthropic').dataset.confirmed).toBe('false')
    expect(count('anthropic').className).not.toContain('text-destructive')
    expect(count('openai').dataset.confirmed).toBe('false')
    expect(count('openai').textContent).toBe('2 models available')
  })

  it("a built-in's curated id matches the vendor's dated snapshot or models/ name; a custom pick must match verbatim", async () => {
    const h = makeHomeHarness([], {}, {
      openai: { ok: true, ids: ['models/gpt-6-astra', 'gpt-6-sol-2026-09-01'] },
      anthropic: { ok: true, ids: ['claude-haiku-4-5-20251001'] },
      [CUSTOM_ID]: { ok: true, ids: ['abc-coder-v2-20260101'] },
    })
    renderHome(h, countCatalog)
    await screen.findByTestId('models-provider-row-anthropic')
    await waitFor(() => expect(count(CUSTOM_ID).dataset.confirmed).toBe('true'))
    expect(count('openai').textContent).toBe('2 models available')
    expect(count('anthropic').textContent).toBe('1 model available')
    expect(count(CUSTOM_ID).textContent).toBe('0 models available')
    expect(count(CUSTOM_ID).className).toContain('text-destructive')
  })

  it('re-fetches every listing when the home page shows again', async () => {
    const h = makeHomeHarness([], {}, { openai: { ok: true, ids: ['gpt-6-astra'] } })
    renderHome(h, countCatalog)
    await screen.findByTestId('models-provider-row-openai')
    await waitFor(() => expect(h.calls.fresh.filter(id => id === 'openai')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('models-provider-settings-openai'))
    await screen.findByTestId('models-back-to-providers')
    fireEvent.click(screen.getByTestId('models-back-to-providers'))
    await waitFor(() => expect(h.calls.fresh.filter(id => id === 'openai')).toHaveLength(2))
  })
})

describe('ModelsSection — the quick picker\'s "Edit…" deep link', () => {
  it('opens the requested provider\'s editor, with its model entries once connected; a new request lands again', async () => {
    const { transport, bridge } = makeHarness({
      openai: { hasApiKey: true, lastVerification: { providerId: 'openai', verifiedAtMs: 1 } },
    })
    const tree = (seq: number) =>
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog, transport, openProviderRequest: { providerId: 'openai', seq } }),
      )
    const view = render(tree(1))
    expect((await screen.findByTestId('models-editing-provider')).textContent).toContain('OpenAI')
    expect(await screen.findByTestId('model-entries')).toBeTruthy()

    fireEvent.click(screen.getByTestId('models-back-to-providers'))
    await screen.findByTestId('models-provider-home')
    // The same request re-rendered does not reopen it…
    view.rerender(tree(1))
    expect(screen.queryByTestId('models-editing-provider')).toBeNull()
    // …a new one does.
    view.rerender(tree(2))
    expect((await screen.findByTestId('models-editing-provider')).textContent).toContain('OpenAI')
  })
})

describe('ModelsSection — empty-provider guidance', () => {
  const emptyCatalog = {
    ...catalog,
    providers: catalog.providers.map(provider => ({ ...provider, enabled: false })),
  }

  function setup(...args: [] | [BrowserLlmCatalog | null | undefined]) {
    const initialCatalog = args.length ? args[0] : emptyCatalog
    const { transport, bridge } = makeHarness({})
    const tree = (value: BrowserLlmCatalog | null | undefined) =>
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(ModelsSection, { catalog: value, transport }),
      )
    return { ...render(tree(initialCatalog)), tree }
  }

  it('opens and highlights the menu on a normal visit; selecting a provider opens its editor', async () => {
    setup()
    const menu = await screen.findByTestId('models-add-provider-menu')
    expect(menu.className).toContain('nexus-provider-guidance')
    expect(screen.getByTestId('models-add-custom-provider')).toBeTruthy()
    fireEvent.click(screen.getByTestId(`models-provider-select-option-${catalog.providers[0].id}`))
    expect((await screen.findByTestId('models-editing-provider')).textContent).toContain(catalog.providers[0].label)
    expect(screen.queryByTestId('models-add-provider-menu')).toBeNull()
  })

  it('does not reopen after dismissal or flash on manual reopen, but guides a fresh visit again', async () => {
    const view = setup()
    await screen.findByTestId('models-add-provider-menu')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('models-add-provider-menu')).toBeNull())
    view.rerender(view.tree({ ...emptyCatalog }))
    expect(screen.queryByTestId('models-add-provider-menu')).toBeNull()
    fireEvent.click(screen.getByTestId('models-add-provider'))
    expect((await screen.findByTestId('models-add-provider-menu')).className).not.toContain('nexus-provider-guidance')
    view.unmount()
    setup()
    expect((await screen.findByTestId('models-add-provider-menu')).className).toContain('nexus-provider-guidance')
  })

  it.each([null, undefined])('waits for the catalog instead of treating %s as empty', async value => {
    const view = setup(value)
    await screen.findByTestId('models-provider-home')
    expect(screen.queryByTestId('models-add-provider-menu')).toBeNull()
    view.rerender(view.tree(emptyCatalog))
    expect(await screen.findByTestId('models-add-provider-menu')).toBeTruthy()
  })

  it('does not guide a configured provider even when it has no models', async () => {
    setup({ ...catalog, providers: catalog.providers.map(provider => ({ ...provider, models: [] })) })
    await screen.findByTestId('models-provider-home')
    expect(screen.queryByTestId('models-add-provider-menu')).toBeNull()
  })

  it.each(['apiKey', 'oauth', 'empty', 'unavailable'] as const)(
    'waits for the initial broker registry before guiding a %s result', async outcome => {
      const { transport, bridge } = makeHarness({})
      let resolveRegistry!: (value: unknown) => void
      let rejectRegistry!: (reason: Error) => void
      const registry = new Promise((resolve, reject) => {
        resolveRegistry = resolve
        rejectRegistry = reject
      })
      vi.mocked(transport.request).mockImplementationOnce(
        () => registry as ReturnType<BrowserBridgeTransport['request']>,
      )
      const provider = catalog.providers[0]
      render(createElement(SettingsBridgeContext.Provider, { value: bridge },
        createElement(ModelsSection, {
          catalog: { providers: [{ ...provider, enabled: false, models: [] }] },
          transport,
        }),
      ))
      await screen.findByTestId('models-provider-list-empty')
      expect(screen.queryByTestId('models-add-provider-menu')).toBeNull()
      await act(async () => {
        if (outcome === 'unavailable') {
          rejectRegistry(new Error('Route unavailable'))
        } else {
          resolveRegistry({ ok: true, result: { providers: [{
            id: provider.id,
            name: provider.label,
            type: 'cloud',
            authMode: outcome === 'oauth' ? 'oauth' : 'apiKey',
            hasStoredApiKey: outcome === 'apiKey',
            isVerified: outcome === 'apiKey',
            connected: outcome === 'oauth',
          }] } })
        }
      })
      if (outcome === 'apiKey' || outcome === 'oauth') {
        await screen.findByTestId(`models-provider-row-${provider.id}`)
        expect(screen.queryByTestId('models-add-provider-menu')).toBeNull()
      } else {
        expect((await screen.findByTestId('models-add-provider-menu')).className)
          .toContain('nexus-provider-guidance')
      }
    },
  )

  it('leaves an explicit provider editor deep link intact', async () => {
    const { transport, bridge } = makeHarness({})
    render(createElement(SettingsBridgeContext.Provider, { value: bridge },
      createElement(ModelsSection, { catalog: emptyCatalog, transport, openProviderRequest: { providerId: catalog.providers[0].id, seq: 1 } }),
    ))
    expect((await screen.findByTestId('models-editing-provider')).textContent).toContain(catalog.providers[0].label)
    expect(screen.queryByTestId('models-add-provider-menu')).toBeNull()
  })
})
