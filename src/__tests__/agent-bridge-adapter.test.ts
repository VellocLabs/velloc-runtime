import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type {
  BrowserBridgeRequest,
  BrowserBridgeRoute,
} from '../browser/bridge/protocol'
import {
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import {
  agentHandlers,
  handleAgentBridgeRequest,
} from '../browser/bridge/adapter/agentBridgeAdapter'

/**
 * Unit-level pinning for the agent capability handlers. Mirrors the
 * shape of `features-bridge-adapter.test.ts` so the migration story
 * stays uniform across capabilities.
 */

function makeMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const fs: Partial<RuntimeFs> = {
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return content
    }),
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    }),
    mkdir: vi.fn(async () => {}),
  }
  return { fs: fs as RuntimeFs, files }
}

const HOME = '/home/test'
const SETTINGS_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

beforeEach(() => {
  wipeSettingsMemos()
})

describe('agentHandlers.snapshot', () => {
  it('returns runtime defaults when no settings file exists', async () => {
    const { fs } = makeMemoryFs()
    const result = await agentHandlers.snapshot({ homeDir: HOME, fs })
    expect(result.values).toEqual({
      maxTurns: 10000,
      log: false,
      trace: false,
    })
    expect(result.overridden).toEqual({})
    expect(result.source).toBe('default')
  })

  it('merges user overrides on top of defaults', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        agent: { log: true, maxTurns: 50 },
      }),
    })
    const result = await agentHandlers.snapshot({ homeDir: HOME, fs })
    expect(result.values).toEqual({
      maxTurns: 50,           // user override
      log: true,              // user override
      trace: false,           // default
    })
    expect(result.overridden).toEqual({ log: true, maxTurns: true })
    expect(result.source).toBe('file')
    // No topbar pick saved → no global default model.
    expect(result.model).toBeUndefined()
  })

  it('returns the saved global default model (the last topbar pick)', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        agent: {
          model: { providerId: 'anthropic', modelId: 'claude-opus-5-5', thinkingTier: 'high' },
        },
      }),
    })
    const result = await agentHandlers.snapshot({ homeDir: HOME, fs })
    expect(result.model).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-opus-5-5',
      thinkingTier: 'high',
    })
  })
})

describe('agentHandlers.setField', () => {
  it('writes a new user override and echoes the effective values', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await agentHandlers.setField(
      { patch: { log: true } },
      { homeDir: HOME, fs },
    )
    expect(result.ok).toBe(true)
    expect(result.values.log).toBe(true)
    expect(result.values.trace).toBe(false)
    expect(JSON.parse(files.get(SETTINGS_PATH)!)).toEqual({
      version: 1,
      agent: { log: true },
    })
  })

  it('null clears the override (reverts to default)', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        agent: { log: true, trace: true },
      }),
    })
    const result = await agentHandlers.setField(
      { patch: { log: null } },
      { homeDir: HOME, fs },
    )
    expect(result.values.log).toBe(false)   // reverted to default
    expect(result.values.trace).toBe(true)  // unchanged
    expect(JSON.parse(files.get(SETTINGS_PATH)!).agent)
      .toEqual({ trace: true })
  })

  it('clearing the last user-override leaves the agent section absent', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        agent: { log: true },
      }),
    })
    await agentHandlers.setField(
      { patch: { log: null } },
      { homeDir: HOME, fs },
    )
    const persisted = JSON.parse(files.get(SETTINGS_PATH)!)
    expect(persisted.agent).toBeUndefined()
    expect(persisted.version).toBe(1)
  })

  it('multiple fields in one patch are applied together', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await agentHandlers.setField(
      { patch: { log: true, trace: true, maxTurns: 100 } },
      { homeDir: HOME, fs },
    )
    expect(result.values).toEqual({
      maxTurns: 100,
      log: true,
      trace: true,
    })
    expect(JSON.parse(files.get(SETTINGS_PATH)!).agent).toEqual({
      log: true,
      trace: true,
      maxTurns: 100,
    })
  })

  it('fires broadcastChanged with the effective values after a successful write',
      async () => {
    const { fs } = makeMemoryFs()
    const broadcastChanged = vi.fn()
    await agentHandlers.setField(
      { patch: { maxTurns: 99 } },
      { homeDir: HOME, fs, broadcastChanged },
    )
    // Exactly one broadcast per write — the registration site fans it
    // out to attached WebUI ports + live engines. The payload carries
    // the EFFECTIVE values (defaults merged with overrides), not the
    // sparse user patch, so consumers don't have to re-merge.
    expect(broadcastChanged).toHaveBeenCalledTimes(1)
    expect(broadcastChanged).toHaveBeenCalledWith({
      values: {
        maxTurns: 99,
        log: false,
        trace: false,
      },
      // Every `agent.changed` states the global default too (none saved).
      model: null,
    })
  })

  it('keeps the saved global default model and states it in the broadcast', async () => {
    const model = { providerId: 'openai', modelId: 'gpt-5', thinkingTier: 'high' }
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({ version: 1, agent: { model } }),
    })
    const broadcastChanged = vi.fn()
    await agentHandlers.setField(
      { patch: { log: true } },
      { homeDir: HOME, fs, broadcastChanged },
    )
    expect(JSON.parse(files.get(SETTINGS_PATH)!).agent).toEqual({ model, log: true })
    expect(broadcastChanged).toHaveBeenCalledWith(
      expect.objectContaining({ model }),
    )
  })

  it('omits broadcastChanged when none is wired (test rigs)', async () => {
    const { fs } = makeMemoryFs()
    // Context with NO broadcastChanged. Setting still succeeds; no
    // throw. Pins that the broadcast hook is genuinely optional —
    // critical for the existing rigs in `webui-bridge-features-cwd-
    // fallback.test.ts` that construct minimal contexts.
    const result = await agentHandlers.setField(
      { patch: { log: true } },
      { homeDir: HOME, fs },
    )
    expect(result.ok).toBe(true)
  })
})

describe('agentHandlers.setModel', () => {
  it('writes agent.model, keeps the other fields, and publishes the new default', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({ version: 1, agent: { log: true } }),
    })
    const broadcastChanged = vi.fn()
    const model = { providerId: 'anthropic', modelId: 'claude-x', thinkingTier: 'max' }
    const result = await agentHandlers.setModel(
      { model },
      { homeDir: HOME, fs, broadcastChanged },
    )
    expect(result).toEqual({ ok: true, model })
    expect(JSON.parse(files.get(SETTINGS_PATH)!).agent).toEqual({ log: true, model })
    // The runtime publishes it — every page mirrors this, not its boot read.
    expect(broadcastChanged).toHaveBeenCalledTimes(1)
    expect(broadcastChanged).toHaveBeenCalledWith({
      values: { maxTurns: 10000, log: true, trace: false },
      model,
    })
  })

  it('drops an empty effort and rejects a model without ids', async () => {
    const { fs, files } = makeMemoryFs()
    const broadcastChanged = vi.fn()
    await agentHandlers.setModel(
      { model: { providerId: 'p', modelId: 'm', thinkingTier: '' } },
      { homeDir: HOME, fs, broadcastChanged },
    )
    expect(JSON.parse(files.get(SETTINGS_PATH)!).agent.model).toEqual({
      providerId: 'p',
      modelId: 'm',
    })
    await expect(
      agentHandlers.setModel(
        { model: { providerId: '', modelId: 'm' } },
        { homeDir: HOME, fs, broadcastChanged },
      ),
    ).rejects.toThrow(/providerId and a modelId/)
    expect(broadcastChanged).toHaveBeenCalledTimes(1)
  })
})

describe('handleAgentBridgeRequest', () => {
  function makeRequest(
    action: 'snapshot' | 'setField' | 'setModel',
    payload: unknown = {},
    id = 'req-1',
  ): BrowserBridgeRequest {
    return {
      id,
      route: {
        namespace: 'nexus',
        capability: 'agent',
        action,
      } as unknown as BrowserBridgeRoute,
      payload: payload as never,
    }
  }

  it('routes snapshot → ok envelope', async () => {
    const { fs } = makeMemoryFs()
    const response = await handleAgentBridgeRequest(
      makeRequest('snapshot'),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(true)
    if (response.ok) {
      const result = response.result as {
        values: { log: boolean }
        source: string
      }
      expect(result.values.log).toBe(false)
      expect(result.source).toBe('default')
    }
  })

  it('routes setField → ok envelope + side effects', async () => {
    const { fs, files } = makeMemoryFs()
    const response = await handleAgentBridgeRequest(
      makeRequest('setField', { patch: { log: true } }),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(true)
    expect(JSON.parse(files.get(SETTINGS_PATH)!).agent).toEqual({ log: true })
  })

  it('returns unknown_action for a bad action name', async () => {
    const { fs } = makeMemoryFs()
    const response = await handleAgentBridgeRequest(
      // @ts-expect-error — deliberately invalid
      makeRequest('does-not-exist'),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('unknown_action')
    }
  })

  it('catches handler errors → agent_handler_error envelope', async () => {
    const { fs } = makeMemoryFs()
    ;(fs.writeFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('disk full')
    })
    const response = await handleAgentBridgeRequest(
      makeRequest('setField', { patch: { log: true } }),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('agent_handler_error')
      expect(response.error.message).toContain('disk full')
    }
  })
})
