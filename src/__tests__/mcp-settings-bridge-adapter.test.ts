import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type {
  BrowserBridgeRequest,
  BrowserBridgeRoute,
  NexusMcpServerConfig,
} from '../browser/bridge/protocol'
import {
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import {
  handleMcpSettingsBridgeRequest,
  mcpSettingsHandlers,
} from '../browser/bridge/adapter/mcpSettingsBridgeAdapter'
import {
  mcpHeaderSecretName,
  mcpSecretPlaceholderName,
  type McpSecretsStore,
} from '../mcp/mcpServerSecrets'

/**
 * The WebUI-facing `mcpSettings` capability: list returns the servers map + source hint; upsert writes (last write
 * wins by id), rejects malformed input and broadcasts; remove deletes and broadcasts, and is idempotent and silent
 * on an unknown id; clearing the last server drops the section; dispatch wraps the standard envelope.
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

describe('mcpSettingsHandlers.list', () => {
  it("returns empty servers + source='default' when no settings file exists",
      async () => {
    const { fs } = makeMemoryFs()
    const result = await mcpSettingsHandlers.list({ homeDir: HOME, fs })
    expect(result.servers).toEqual({})
    expect(result.source).toBe('default')
  })

  it('reads the mcp.servers map from settings.json', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        mcp: {
          servers: {
            github: { transport: 'http', url: 'https://api.example' },
            local: { transport: 'stdio', command: 'mcp-local' },
          },
        },
      }),
    })
    const result = await mcpSettingsHandlers.list({ homeDir: HOME, fs })
    expect(result.source).toBe('file')
    expect(result.servers).toEqual({
      github: { transport: 'http', url: 'https://api.example' },
      local: { transport: 'stdio', command: 'mcp-local' },
    })
  })
})

describe('mcpSettingsHandlers.upsert', () => {
  it('writes a new server and fires broadcastChanged', async () => {
    const { fs, files } = makeMemoryFs()
    const broadcastChanged = vi.fn()
    const result = await mcpSettingsHandlers.upsert(
      {
        id: 'github',
        config: { transport: 'http', url: 'https://api.example' },
      },
      { homeDir: HOME, fs, broadcastChanged },
    )
    expect(result.ok).toBe(true)
    expect(result.servers).toEqual({
      github: { transport: 'http', url: 'https://api.example' },
    })
    expect(broadcastChanged).toHaveBeenCalledTimes(1)
    expect(broadcastChanged).toHaveBeenCalledWith({
      servers: {
        github: { transport: 'http', url: 'https://api.example' },
      },
    })
    expect(JSON.parse(files.get(SETTINGS_PATH)!).mcp.servers.github)
        .toEqual({ transport: 'http', url: 'https://api.example' })
  })

  it('overwrites an existing entry with the same id', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        mcp: { servers: { github: { transport: 'http', url: 'https://old' } } },
      }),
    })
    await mcpSettingsHandlers.upsert(
      {
        id: 'github',
        config: { transport: 'http', url: 'https://new' },
      },
      { homeDir: HOME, fs },
    )
    expect(JSON.parse(files.get(SETTINGS_PATH)!).mcp.servers.github)
        .toEqual({ transport: 'http', url: 'https://new' })
  })

  it('preserves OTHER servers when upserting one', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        mcp: { servers: { a: { transport: 'stdio', command: 'a' } } },
      }),
    })
    await mcpSettingsHandlers.upsert(
      { id: 'b', config: { transport: 'stdio', command: 'b' } },
      { homeDir: HOME, fs },
    )
    const persisted = JSON.parse(files.get(SETTINGS_PATH)!).mcp.servers
    expect(Object.keys(persisted).sort()).toEqual(['a', 'b'])
    expect(persisted.a.command).toBe('a')
    expect(persisted.b.command).toBe('b')
  })

  it('rejects stdio config without a command', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      mcpSettingsHandlers.upsert(
        { id: 'bad', config: { transport: 'stdio' } as NexusMcpServerConfig },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/command/i)
  })

  it('rejects http config without a url', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      mcpSettingsHandlers.upsert(
        { id: 'bad', config: { transport: 'http' } as NexusMcpServerConfig },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/url/i)
  })

  it('rejects empty/whitespace-containing ids', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      mcpSettingsHandlers.upsert(
        { id: '', config: { transport: 'stdio', command: 'x' } },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/non-empty/i)
    await expect(
      mcpSettingsHandlers.upsert(
        { id: 'has space', config: { transport: 'stdio', command: 'x' } },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/whitespace/i)
  })
})

describe('mcpSettingsHandlers.remove', () => {
  it('deletes an existing server and fires broadcastChanged', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        mcp: {
          servers: {
            a: { transport: 'stdio', command: 'a' },
            b: { transport: 'stdio', command: 'b' },
          },
        },
      }),
    })
    const broadcastChanged = vi.fn()
    const result = await mcpSettingsHandlers.remove(
      { id: 'a' },
      { homeDir: HOME, fs, broadcastChanged },
    )
    expect(result.servers).toEqual({ b: { transport: 'stdio', command: 'b' } })
    expect(broadcastChanged).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(files.get(SETTINGS_PATH)!)
    expect(persisted.mcp.servers).toEqual({
      b: { transport: 'stdio', command: 'b' },
    })
  })

  it('drops the whole mcp section when the last server is removed',
      async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        mcp: { servers: { only: { transport: 'stdio', command: 'x' } } },
      }),
    })
    await mcpSettingsHandlers.remove(
      { id: 'only' },
      { homeDir: HOME, fs },
    )
    const persisted = JSON.parse(files.get(SETTINGS_PATH)!)
    expect(persisted.mcp).toBeUndefined()
    expect(persisted.version).toBe(1)
  })

  it('is idempotent on unknown id — no write, no broadcast', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        mcp: { servers: { exists: { transport: 'stdio', command: 'x' } } },
      }),
    })
    const writeSpy = fs.writeFile as ReturnType<typeof vi.fn>
    writeSpy.mockClear()
    const broadcastChanged = vi.fn()
    await mcpSettingsHandlers.remove(
      { id: 'never-was' },
      { homeDir: HOME, fs, broadcastChanged },
    )
    expect(writeSpy).not.toHaveBeenCalled()
    expect(broadcastChanged).not.toHaveBeenCalled()
    expect(JSON.parse(files.get(SETTINGS_PATH)!).mcp.servers).toEqual({
      exists: { transport: 'stdio', command: 'x' },
    })
  })
})

describe('handleMcpSettingsBridgeRequest', () => {
  function makeRequest(
    action: 'list' | 'upsert' | 'remove',
    payload: unknown = {},
    id = 'req-1',
  ): BrowserBridgeRequest {
    return {
      id,
      route: {
        namespace: 'nexus',
        capability: 'mcpSettings',
        action,
      } as unknown as BrowserBridgeRoute,
      payload: payload as never,
    }
  }

  it('routes list → ok envelope', async () => {
    const { fs } = makeMemoryFs()
    const response = await handleMcpSettingsBridgeRequest(
      makeRequest('list'),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(true)
  })

  it('routes upsert → ok envelope + side effects', async () => {
    const { fs, files } = makeMemoryFs()
    const response = await handleMcpSettingsBridgeRequest(
      makeRequest('upsert', {
        id: 's',
        config: { transport: 'stdio', command: 'cmd' },
      }),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(true)
    expect(JSON.parse(files.get(SETTINGS_PATH)!).mcp.servers.s).toEqual({
      transport: 'stdio',
      command: 'cmd',
    })
  })

  it('catches handler errors → mcp_settings_handler_error envelope',
      async () => {
    const { fs } = makeMemoryFs()
    const response = await handleMcpSettingsBridgeRequest(
      makeRequest('upsert', {
        id: 'bad',
        config: { transport: 'stdio' }, // missing command
      }),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('mcp_settings_handler_error')
      expect(response.error.message).toMatch(/command/i)
    }
  })

  it('returns unknown_action for an invalid action name', async () => {
    const { fs } = makeMemoryFs()
    const response = await handleMcpSettingsBridgeRequest(
      // @ts-expect-error — deliberately invalid
      makeRequest('does-not-exist'),
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('unknown_action')
    }
  })
})

// ---------------------------------------------------------------------------
// Credentials → the host `secrets` store (src/mcp/mcpServerSecrets.ts) and
// the worker-run connection test.
// ---------------------------------------------------------------------------

/** An in-memory `secrets` store with the host's rules that matter here:
 *  values never come back, each name is bound to one origin (`''` for a
 *  process-only secret, which needs the `processEnv` mark). */
function makeSecrets() {
  const store = new Map<string, { value: string; origin: string; processEnv?: boolean }>()
  const secrets: McpSecretsStore = {
    set: vi.fn(async (name: string, value: string, origin: string | undefined, options?: { processEnv?: boolean }) => {
      if (origin === undefined && !options?.processEnv) throw new Error('INVALID_ARGS: origin required')
      store.set(name, { value, origin: origin ?? '', ...(options?.processEnv ? { processEnv: true } : {}) })
    }),
    has: vi.fn(async (name: string) => {
      const entry = store.get(name)
      return entry ? { exists: true, origin: entry.origin } : { exists: false }
    }),
    delete: vi.fn(async (name: string) => store.delete(name)),
    listNames: vi.fn(async () =>
      Array.from(store.entries())
        .map(([name, entry]) => ({ name, origin: entry.origin }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ),
  }
  return { secrets, store }
}

function persistedServer(files: Map<string, string>, id: string): NexusMcpServerConfig | undefined {
  const raw = files.get(SETTINGS_PATH)
  if (!raw) return undefined
  return (JSON.parse(raw) as { mcp?: { servers?: Record<string, NexusMcpServerConfig> } })
    .mcp?.servers?.[id]
}

describe('mcpSettings credentials', () => {
  const URL_A = 'https://api.example.com/mcp/'

  it('moves credential headers into the store and persists placeholders', async () => {
    const { fs, files } = makeMemoryFs()
    const { secrets, store } = makeSecrets()
    await mcpSettingsHandlers.upsert(
      {
        id: 'github',
        config: {
          transport: 'http',
          url: URL_A,
          headers: { Authorization: 'Bearer ghp_secret', 'X-Api-Key': 'k-1', 'X-Trace': 'on' },
        },
      },
      { homeDir: HOME, fs, secrets },
    )
    expect(files.get(SETTINGS_PATH)).not.toContain('ghp_secret')
    expect(files.get(SETTINGS_PATH)).not.toContain('k-1')
    expect(persistedServer(files, 'github')?.headers).toEqual({
      Authorization: '{{secret:mcp:github/header/authorization}}',
      'X-Api-Key': '{{secret:mcp:github/header/x-api-key}}',
      // Not a credential: stays as typed.
      'X-Trace': 'on',
    })
    expect(store.get('mcp:github/header/authorization')).toEqual({
      value: 'Bearer ghp_secret',
      origin: 'https://api.example.com',
    })
  })

  it('keeps a placeholder on re-save, and prunes a credential the edit dropped', async () => {
    const { fs, files } = makeMemoryFs()
    const { secrets, store } = makeSecrets()
    const ctx = { homeDir: HOME, fs, secrets }
    await mcpSettingsHandlers.upsert(
      { id: 'gh', config: { transport: 'http', url: URL_A, headers: { Authorization: 'Bearer a', 'X-Api-Key': 'b' } } },
      ctx,
    )
    const saved = persistedServer(files, 'gh')!
    vi.mocked(secrets.set).mockClear()
    await mcpSettingsHandlers.upsert(
      { id: 'gh', config: { transport: 'http', url: URL_A, headers: { Authorization: saved.headers!.Authorization! } } },
      ctx,
    )
    expect(secrets.set).not.toHaveBeenCalled()
    expect(persistedServer(files, 'gh')?.headers).toEqual({
      Authorization: '{{secret:mcp:gh/header/authorization}}',
    })
    expect(Array.from(store.keys())).toEqual(['mcp:gh/header/authorization'])
  })

  it('a re-save whose settings write fails leaves the saved credential as it was, and discards the new one', async () => {
    const { fs, files } = makeMemoryFs()
    const { secrets, store } = makeSecrets()
    const ctx = { homeDir: HOME, fs, secrets }
    await mcpSettingsHandlers.upsert(
      { id: 'gh', config: { transport: 'http', url: URL_A, headers: { Authorization: 'Bearer old' } } },
      ctx,
    )
    const before = persistedServer(files, 'gh')
    vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('EBUSY'))
    await expect(
      mcpSettingsHandlers.upsert(
        { id: 'gh', config: { transport: 'http', url: URL_A, headers: { Authorization: 'Bearer new' } } },
        ctx,
      ),
    ).rejects.toThrow('EBUSY')
    expect(persistedServer(files, 'gh')).toEqual(before)
    expect(Array.from(store.keys())).toEqual(['mcp:gh/header/authorization'])
    expect(store.get('mcp:gh/header/authorization')).toMatchObject({ value: 'Bearer old' })
    // The next save that lands takes a fresh name and prunes the old one.
    await mcpSettingsHandlers.upsert(
      { id: 'gh', config: { transport: 'http', url: URL_A, headers: { Authorization: 'Bearer new' } } },
      ctx,
    )
    const placeholder = persistedServer(files, 'gh')!.headers!.Authorization!
    expect(placeholder).toMatch(/^\{\{secret:mcp:gh\/header\/authorization@[0-9a-z]+\}\}$/)
    expect(Array.from(store.keys())).toEqual([placeholder.slice('{{secret:'.length, -2)])
  })

  it('refuses a placeholder whose stored value belongs to another origin', async () => {
    const { fs } = makeMemoryFs()
    const { secrets } = makeSecrets()
    const ctx = { homeDir: HOME, fs, secrets }
    await mcpSettingsHandlers.upsert(
      { id: 'gh', config: { transport: 'http', url: URL_A, headers: { Authorization: 'Bearer a' } } },
      ctx,
    )
    await expect(
      mcpSettingsHandlers.upsert(
        {
          id: 'gh',
          config: {
            transport: 'http',
            url: 'https://elsewhere.example.org/mcp',
            headers: { Authorization: '{{secret:mcp:gh/header/authorization}}' },
          },
        },
        ctx,
      ),
    ).rejects.toThrow(/belongs to https:\/\/api\.example\.com/)
  })

  it('refuses to write a credential in plaintext when the host has no store', async () => {
    const { fs, files } = makeMemoryFs()
    await expect(
      mcpSettingsHandlers.upsert(
        { id: 'gh', config: { transport: 'http', url: URL_A, headers: { Authorization: 'Bearer a' } } },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/Secure storage is unavailable/)
    expect(files.has(SETTINGS_PATH)).toBe(false)
    // A server without credentials still saves.
    await mcpSettingsHandlers.upsert(
      { id: 'open', config: { transport: 'http', url: URL_A, headers: { 'X-Trace': 'on' } } },
      { homeDir: HOME, fs },
    )
    expect(persistedServer(files, 'open')?.headers).toEqual({ 'X-Trace': 'on' })
  })

  it("remove deletes the server's secrets and no other server's", async () => {
    const { fs } = makeMemoryFs()
    const { secrets, store } = makeSecrets()
    const ctx = { homeDir: HOME, fs, secrets }
    for (const id of ['a', 'ab']) {
      await mcpSettingsHandlers.upsert(
        { id, config: { transport: 'http', url: URL_A, headers: { Authorization: `Bearer ${id}` } } },
        ctx,
      )
    }
    await mcpSettingsHandlers.remove({ id: 'a' }, ctx)
    expect(Array.from(store.keys())).toEqual(['mcp:ab/header/authorization'])
  })

  it("moves a stdio server's credential env vars into the store as process-only secrets", async () => {
    const { fs, files } = makeMemoryFs()
    const { secrets, store } = makeSecrets()
    await mcpSettingsHandlers.upsert(
      {
        id: 'gh',
        config: {
          transport: 'stdio',
          command: 'npx',
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_secret', OPENAI_API_KEY: 'sk-1', LOG_LEVEL: 'debug' },
        },
      },
      { homeDir: HOME, fs, secrets },
    )
    expect(files.get(SETTINGS_PATH)).not.toContain('ghp_secret')
    expect(files.get(SETTINGS_PATH)).not.toContain('sk-1')
    expect(persistedServer(files, 'gh')?.env).toEqual({
      GITHUB_PERSONAL_ACCESS_TOKEN: '{{secret:mcp:gh/env/GITHUB_5f_PERSONAL_5f_ACCESS_5f_TOKEN}}',
      OPENAI_API_KEY: '{{secret:mcp:gh/env/OPENAI_5f_API_5f_KEY}}',
      // Not a credential: stays as typed.
      LOG_LEVEL: 'debug',
    })
    // No origin: no network request can ever carry it.
    expect(store.get('mcp:gh/env/OPENAI_5f_API_5f_KEY')).toEqual({ value: 'sk-1', origin: '', processEnv: true })
  })

  it('keeps an env placeholder on re-save, and refuses one naming a header secret', async () => {
    const { fs, files } = makeMemoryFs()
    const { secrets, store } = makeSecrets()
    const ctx = { homeDir: HOME, fs, secrets }
    await mcpSettingsHandlers.upsert(
      { id: 'gh', config: { transport: 'stdio', command: 'npx', env: { API_TOKEN: 't-1' } } },
      ctx,
    )
    const saved = persistedServer(files, 'gh')!
    vi.mocked(secrets.set).mockClear()
    await mcpSettingsHandlers.upsert(
      { id: 'gh', config: { transport: 'stdio', command: 'npx', env: { API_TOKEN: saved.env!.API_TOKEN! } } },
      ctx,
    )
    expect(secrets.set).not.toHaveBeenCalled()
    expect(Array.from(store.keys())).toEqual(['mcp:gh/env/API_5f_TOKEN'])

    // An origin-bound (header) secret is not the child's to read.
    await mcpSettingsHandlers.upsert(
      { id: 'web', config: { transport: 'http', url: URL_A, headers: { Authorization: 'Bearer a' } } },
      ctx,
    )
    await expect(
      mcpSettingsHandlers.upsert(
        {
          id: 'gh',
          config: { transport: 'stdio', command: 'npx', env: { API_TOKEN: '{{secret:mcp:web/header/authorization}}' } },
        },
        ctx,
      ),
    ).rejects.toThrow(/belongs to https:\/\/api\.example\.com/)
  })

  it('refuses to write a credential env var in plaintext when the host has no store', async () => {
    const { fs, files } = makeMemoryFs()
    await expect(
      mcpSettingsHandlers.upsert(
        { id: 'gh', config: { transport: 'stdio', command: 'npx', env: { API_TOKEN: 't' } } },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/Secure storage is unavailable/)
    expect(files.has(SETTINGS_PATH)).toBe(false)
  })

  it('names are injective in the store alphabet', () => {
    expect(mcpHeaderSecretName('a_b', 'Authorization')).not.toBe(mcpHeaderSecretName('a+b', 'Authorization'))
    expect(mcpHeaderSecretName('a_b', 'X')).toMatch(/^mcp:[A-Za-z0-9_.:/@-]+$/)
    expect(mcpSecretPlaceholderName(' {{secret:mcp:a/header/x}} ')).toBe('mcp:a/header/x')
    expect(mcpSecretPlaceholderName('Bearer {{secret:mcp:a/header/x}}')).toBeNull()
    expect(mcpSecretPlaceholderName('{{secret:provider:x}}')).toBeNull()
  })
})

describe('mcpSettings.testConnect', () => {
  it('delegates to the worker MCP client', async () => {
    const { fs } = makeMemoryFs()
    const testConnect = vi.fn(async () => ({ ok: true, toolCount: 3, serverName: 'srv' }))
    const response = await handleMcpSettingsBridgeRequest(
      {
        id: 't1',
        route: { namespace: 'nexus', capability: 'mcpSettings', action: 'testConnect' } as BrowserBridgeRoute,
        payload: { config: { transport: 'stdio', command: 'node' } },
      } as BrowserBridgeRequest,
      { homeDir: HOME, fs, testConnect },
    )
    expect(testConnect).toHaveBeenCalledWith({ transport: 'stdio', command: 'node' })
    expect(response).toMatchObject({ ok: true, result: { ok: true, toolCount: 3, serverName: 'srv' } })
  })

  it('errors on a host that cannot run MCP servers (the form saves unprobed)', async () => {
    const { fs } = makeMemoryFs()
    const response = await handleMcpSettingsBridgeRequest(
      {
        id: 't2',
        route: { namespace: 'nexus', capability: 'mcpSettings', action: 'testConnect' } as BrowserBridgeRoute,
        payload: { config: { transport: 'stdio', command: 'node' } },
      } as BrowserBridgeRequest,
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(false)
  })
})
