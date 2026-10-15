/**
 * Provider mods PM-7 - the sign-in state machine of `ProviderCredentials`,
 * against a fake module runtime: every step kind, answers (idempotent per
 * step, stale ones refused), cancel, the wall clock, the result write and a
 * module that fails. The real worker is `provider-mod-login.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProviderCredentials,
  CredentialRefusal,
  parseCredentialResult,
  type CredentialDeps,
  type CredentialRuntime,
} from '../mods/provider/login/providerCredentials'
import type { ProviderLoginState } from '../mods/provider/login/loginProtocol'
import type { NexusProviderConfig } from '../settings/settingsTypes'

const ID = 'mod.acme.main'
const OWN = [ID]

type Login = (e: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<unknown>

function rig(
  login: Login,
  options: {
    stored?: NexusProviderConfig
    methods?: string[]
    writeFails?: boolean
    wallMs?: number
    refresh?: (reason: string) => Promise<unknown>
    logout?: () => Promise<unknown>
    hooks?: Partial<Record<string, boolean>>
  } = {},
) {
  const configs: Record<string, NexusProviderConfig | undefined> = {
    [ID]: options.stored ?? { source: 'mod', modVersion: '1.0.0' },
  }
  const writes: NexusProviderConfig[] = []
  const calls: Array<{ event: string; e: Record<string, unknown> }> = []
  const runtime: CredentialRuntime = {
    hasHook: (_id, event) => options.hooks?.[event],
    call: (async (_id: string, event: string, e: Record<string, unknown> = {}, callOptions: { signal?: AbortSignal } = {}) => {
      calls.push({ event, e })
      if (event === 'provider.login') return { raised: true, value: await login(e, callOptions.signal) }
      if (event === 'provider.refresh') {
        if (!options.refresh) return { raised: false }
        return { raised: true, value: await options.refresh(String(e.reason)) }
      }
      if (event === 'provider.logout') {
        if (!options.logout) return { raised: false }
        await options.logout()
        return { raised: true, value: undefined }
      }
      return { raised: false }
    }) as CredentialRuntime['call'],
  }
  const deps: CredentialDeps = {
    runtime: () => runtime,
    describe: id =>
      id === ID ? { secrets: ['access_token', 'refresh_token'], methods: options.methods ?? ['login'] } : undefined,
    storedConfigOf: id => configs[id],
    writeConfig: async (id, config) => {
      if (options.writeFails) throw new Error('disk full')
      writes.push(config)
      // The settings path replaces the entry and merges secrets name by name.
      const prev = configs[id] ?? {}
      const merged: Record<string, string> = { ...(prev as { storedSecretValues?: Record<string, string> }).storedSecretValues }
      for (const [name, value] of Object.entries(config.secrets ?? {})) {
        if (value === '') delete merged[name]
        else merged[name] = value
      }
      const { secrets: _secrets, ...rest } = config
      configs[id] = { ...rest, ...(Object.keys(merged).length ? { storedSecrets: Object.keys(merged) } : {}) } as NexusProviderConfig
      ;(configs[id] as { storedSecretValues?: Record<string, string> }).storedSecretValues = merged
    },
    report: () => {},
    ...(options.wallMs !== undefined ? { wallMs: options.wallMs } : {}),
  }
  const service = new ProviderCredentials(deps)
  const states: ProviderLoginState[] = []
  service.subscribe(state => states.push(state))
  return { service, configs, writes, calls, states }
}

const session = (service: ProviderCredentials) => service.state().logins[ID]
const stepKind = (service: ProviderCredentials) => session(service)?.step.kind
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('startLogin', () => {
  it('opens one session in the working step and publishes it', async () => {
    const r = rig(() => new Promise(() => {}))
    const started = r.service.startLogin(ID)
    expect(started.joined).toBe(false)
    expect(stepKind(r.service)).toBe('working')
    expect(r.states.at(-1)?.logins[ID]?.loginId).toBe(started.loginId)
    expect(r.states.at(-1)!.seq).toBeGreaterThan(0)
  })

  it('a second start while one runs JOINS it - one session per provider', async () => {
    const r = rig(() => new Promise(() => {}))
    const first = r.service.startLogin(ID)
    const second = r.service.startLogin(ID)
    expect(second).toEqual({ loginId: first.loginId, joined: true })
    expect(r.calls.filter(c => c.event === 'provider.login')).toHaveLength(1)
  })

  it('refuses a provider that is not registered, or does not offer sign-in', () => {
    const r = rig(() => new Promise(() => {}), { methods: ['apiKey'] })
    expect(() => r.service.startLogin('mod.other.x')).toThrow(CredentialRefusal)
    expect(() => r.service.startLogin(ID)).toThrow(/does not offer sign-in/)
    expect(r.service.state().logins).toEqual({})
  })

  it('hands the module its loginId and method', async () => {
    const r = rig(() => new Promise(() => {}))
    const { loginId } = r.service.startLogin(ID)
    await flush()
    expect(r.calls[0]).toMatchObject({ event: 'provider.login', e: { loginId, method: 'login' } })
  })
})

describe('the steps', () => {
  it('openUrl waits for the click; showCode and progress return at once and stay up', async () => {
    let opened: Promise<unknown> | undefined
    const r = rig(async e => {
      const id = e.loginId
      opened = r.service.interact(id, OWN, { kind: 'openUrl', url: 'https://auth.example/start' })
      await opened
      await r.service.interact(id, OWN, { kind: 'showCode', code: 'ABCD-1234', url: 'https://auth.example/device' })
      expect(stepKind(r.service)).toBe('code')
      await r.service.interact(id, OWN, { kind: 'progress', text: 'Waiting for the vendor' })
      return new Promise(() => {})
    })
    const { loginId } = r.service.startLogin(ID)
    await flush()
    expect(session(r.service)!.step).toEqual({ kind: 'openUrl', url: 'https://auth.example/start' })
    // Not answered yet: the module is still waiting.
    let done = false
    void opened!.then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    const stepId = session(r.service)!.stepId
    expect(r.service.answer({ loginId, stepId, value: { kind: 'ack' } })).toEqual({ accepted: true })
    await flush()
    expect(done).toBe(true)
    expect(session(r.service)!.step).toEqual({ kind: 'progress', text: 'Waiting for the vendor' })
  })

  it('a code step carries the code and where to enter it', async () => {
    const r = rig(async e => {
      await r.service.interact(e.loginId, OWN, { kind: 'showCode', code: 'WXYZ', url: 'https://auth.example/device' })
      return new Promise(() => {})
    })
    r.service.startLogin(ID)
    await flush()
    expect(session(r.service)!.step).toEqual({ kind: 'code', code: 'WXYZ', url: 'https://auth.example/device' })
  })

  it('prompt: the answer reaches the module and is NOT echoed in the published state', async () => {
    let got: unknown
    const r = rig(async e => {
      got = await r.service.interact(e.loginId, OWN, { kind: 'prompt', label: 'Paste the code', secret: true })
      return new Promise(() => {})
    })
    const { loginId } = r.service.startLogin(ID)
    await flush()
    const step = session(r.service)!
    expect(step.step).toEqual({ kind: 'prompt', label: 'Paste the code', secret: true })
    r.service.answer({ loginId, stepId: step.stepId, value: { kind: 'text', text: 'tok-SECRET-123' } })
    await flush()
    expect(got).toBe('tok-SECRET-123')
    // No published state, current or past, carries the answer.
    expect(JSON.stringify(r.states)).not.toContain('tok-SECRET-123')
    expect(stepKind(r.service)).toBe('working')
  })

  it('choose: the answer is an index; the module gets the option VALUE; an index out of range is refused', async () => {
    let got: unknown
    const r = rig(async e => {
      got = await r.service.interact(e.loginId, OWN, {
        kind: 'choose',
        label: { en: 'Which workspace?', de: 'Welcher Arbeitsbereich?' },
        options: [{ label: 'Personal', value: 'ws-1' }, { label: { en: 'Team' }, value: 'ws-2' }, 'plain'],
      })
      return new Promise(() => {})
    })
    const { loginId } = r.service.startLogin(ID)
    await flush()
    const current = session(r.service)!
    expect(current.step).toEqual({
      kind: 'choose',
      label: { en: 'Which workspace?', de: 'Welcher Arbeitsbereich?' },
      options: [{ label: 'Personal' }, { label: { en: 'Team' } }, { label: 'plain' }],
    })
    // Values are the module's: they are not published.
    expect(JSON.stringify(current)).not.toContain('ws-1')
    expect(() => r.service.answer({ loginId, stepId: current.stepId, value: { kind: 'choice', index: 3 } })).toThrow(/does not exist/)
    r.service.answer({ loginId, stepId: current.stepId, value: { kind: 'choice', index: 1 } })
    await flush()
    expect(got).toBe('ws-2')
  })

  it('refuses an answer of the wrong kind for the step', async () => {
    const r = rig(async e => {
      await r.service.interact(e.loginId, OWN, { kind: 'prompt', label: 'Code', secret: false })
      return new Promise(() => {})
    })
    const { loginId } = r.service.startLogin(ID)
    await flush()
    const { stepId } = session(r.service)!
    expect(() => r.service.answer({ loginId, stepId, value: { kind: 'ack' } })).toThrow(/takes text/)
    expect(() => r.service.answer({ loginId, stepId, value: { kind: 'choice', index: 0 } })).toThrow(/takes text/)
  })
})

describe('interact validation', () => {
  const interactWith = async (spec: Parameters<ProviderCredentials['interact']>[2]) => {
    let outcome: unknown
    const r = rig(async e => {
      outcome = await r.service.interact(e.loginId, OWN, spec).then(
        () => 'ok',
        (error: Error) => error,
      )
      return new Promise(() => {})
    })
    r.service.startLogin(ID)
    await flush()
    return { outcome, r }
  }

  it.each([
    ['javascript:alert(1)'],
    ['file:///etc/passwd'],
    ['data:text/html,<b>x</b>'],
    ['chrome://settings'],
    ['ftp://example.com/x'],
    ['not a url'],
    ['https://user:pw@example.com/'],
    [''],
  ])('openUrl refuses %s', async url => {
    const { outcome, r } = await interactWith({ kind: 'openUrl', url })
    expect(outcome).toBeInstanceOf(TypeError)
    // The page never saw it.
    expect(stepKind(r.service)).toBe('working')
  })

  it('openUrl and showCode accept http and https only', async () => {
    const http = await interactWith({ kind: 'showCode', code: 'AB', url: 'http://localhost:9000/device' })
    expect(http.outcome).toBe('ok')
    const bad = await interactWith({ kind: 'showCode', code: 'AB', url: 'javascript:1' })
    expect(bad.outcome).toBeInstanceOf(TypeError)
  })

  it('refuses a multi-line or oversized code, a bad label, an empty or duplicate option list', async () => {
    expect((await interactWith({ kind: 'showCode', code: 'A\nB', url: 'https://x.example/' })).outcome).toBeInstanceOf(TypeError)
    expect((await interactWith({ kind: 'showCode', code: 'x'.repeat(129), url: 'https://x.example/' })).outcome).toBeInstanceOf(TypeError)
    expect((await interactWith({ kind: 'prompt', label: 42, secret: false })).outcome).toBeInstanceOf(TypeError)
    expect((await interactWith({ kind: 'prompt', label: 'ok', secret: 'yes' })).outcome).toBeInstanceOf(TypeError)
    expect((await interactWith({ kind: 'choose', label: 'x', options: [] })).outcome).toBeInstanceOf(TypeError)
    expect((await interactWith({ kind: 'choose', label: 'x', options: ['a', 'a'] })).outcome).toBeInstanceOf(TypeError)
    expect((await interactWith({ kind: 'choose', label: 'x', options: [{ label: 'a' }] })).outcome).toBeInstanceOf(TypeError)
    expect((await interactWith({ kind: 'progress', text: '' })).outcome).toBeInstanceOf(TypeError)
  })

  it('a call about a login this module does not own - or none - is refused', async () => {
    const r = rig(() => new Promise(() => {}))
    const { loginId } = r.service.startLogin(ID)
    await expect(r.service.interact(loginId, ['mod.other.x'], { kind: 'progress', text: 'x' })).rejects.toMatchObject({
      name: 'NotAllowedError',
    })
    await expect(r.service.interact('login-nope', OWN, { kind: 'progress', text: 'x' })).rejects.toMatchObject({
      name: 'NotAllowedError',
    })
    await expect(r.service.interact(undefined, OWN, { kind: 'progress', text: 'x' })).rejects.toBeInstanceOf(TypeError)
  })
})

describe('answers', () => {
  async function prompting() {
    const answers: string[] = []
    const r = rig(async e => {
      answers.push((await r.service.interact(e.loginId, OWN, { kind: 'prompt', label: 'First', secret: false })) as string)
      answers.push((await r.service.interact(e.loginId, OWN, { kind: 'prompt', label: 'Second', secret: false })) as string)
      return new Promise(() => {})
    })
    const { loginId } = r.service.startLogin(ID)
    await flush()
    return { r, loginId, answers }
  }

  it('is idempotent per step id: the same step answered again does nothing the second time', async () => {
    const { r, loginId, answers } = await prompting()
    const first = session(r.service)!.stepId
    expect(r.service.answer({ loginId, stepId: first, value: { kind: 'text', text: 'one' } })).toEqual({ accepted: true })
    await flush()
    expect(r.service.answer({ loginId, stepId: first, value: { kind: 'text', text: 'one' } })).toEqual({
      accepted: false,
      duplicate: true,
    })
    await flush()
    expect(answers).toEqual(['one'])
    // The next step is the second prompt, untouched by the duplicate.
    expect(session(r.service)!.step).toMatchObject({ kind: 'prompt', label: 'Second' })
  })

  it('refuses an answer for a step that is not the current one (stale) or a login that is gone', async () => {
    const { r, loginId } = await prompting()
    expect(() => r.service.answer({ loginId, stepId: `${loginId}:99`, value: { kind: 'text', text: 'x' } })).toThrow(
      expect.objectContaining({ code: 'stale' }),
    )
    expect(() => r.service.answer({ loginId: 'login-gone', stepId: 'login-gone:1', value: { kind: 'ack' } })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    )
  })

  it('refuses a malformed payload', async () => {
    const { r, loginId } = await prompting()
    const stepId = session(r.service)!.stepId
    const bad = [
      { loginId: 5, stepId, value: { kind: 'ack' } },
      { loginId, stepId: '', value: { kind: 'ack' } },
      { loginId, stepId, value: { kind: 'text', text: 7 } },
      { loginId, stepId, value: { kind: 'text', text: 'x'.repeat(16 * 1024 + 1) } },
      { loginId, stepId, value: { kind: 'choice', index: -1 } },
      { loginId, stepId, value: { kind: 'eval' } },
      null,
    ]
    for (const payload of bad) {
      expect(() => r.service.answer(payload as never), JSON.stringify(payload)?.slice(0, 40)).toThrow(
        expect.objectContaining({ code: 'bad_payload' }),
      )
    }
  })

  it('a step the module replaced before it was answered ends that call', async () => {
    let first: Promise<unknown> | undefined
    const r = rig(async e => {
      first = r.service.interact(e.loginId, OWN, { kind: 'prompt', label: 'A', secret: false }).catch(error => error)
      await Promise.resolve()
      await r.service.interact(e.loginId, OWN, { kind: 'progress', text: 'moved on' })
      return new Promise(() => {})
    })
    r.service.startLogin(ID)
    await flush()
    expect(await first).toMatchObject({ name: 'AbortError' })
  })
})

describe('cancel and the wall clock', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('cancel rejects the pending interact (AbortError), aborts the call and drops the session', async () => {
    let pending: unknown
    let signal: AbortSignal | undefined
    const r = rig(async (e, s) => {
      signal = s
      pending = await r.service.interact(e.loginId, OWN, { kind: 'prompt', label: 'A', secret: false }).catch(error => error)
      return new Promise(() => {})
    })
    const { loginId } = r.service.startLogin(ID)
    await vi.advanceTimersByTimeAsync(0)
    r.service.cancel(loginId)
    await vi.advanceTimersByTimeAsync(0)
    expect(pending).toMatchObject({ name: 'AbortError', message: expect.stringContaining('cancelled') })
    expect(signal!.aborted).toBe(true)
    expect(r.service.state().logins).toEqual({})
    // Cancelling again, or a login that never was, is fine.
    r.service.cancel(loginId)
    r.service.cancel('login-nope')
    // A new sign-in can start.
    expect(r.service.startLogin(ID).joined).toBe(false)
  })

  it('the 10 minute wall clock fails the sign-in with timeout and rejects what is pending', async () => {
    let pending: unknown
    const r = rig(async e => {
      pending = await r.service.interact(e.loginId, OWN, { kind: 'prompt', label: 'A', secret: false }).catch(error => error)
      return new Promise(() => {})
    })
    r.service.startLogin(ID)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(stepKind(r.service)).toBe('prompt')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(session(r.service)!.step).toMatchObject({ kind: 'failed', code: 'timeout' })
    expect(pending).toBeInstanceOf(Error)
    // Interact after the end rejects too.
    await expect(r.service.interact(session(r.service)!.loginId, OWN, { kind: 'progress', text: 'x' })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('an ended session is dismissed by cancel, and a new start replaces it', async () => {
    const r = rig(async () => {
      throw new Error('boom')
    })
    const { loginId } = r.service.startLogin(ID)
    await vi.advanceTimersByTimeAsync(0)
    expect(stepKind(r.service)).toBe('failed')
    r.service.cancel(loginId)
    expect(r.service.state().logins).toEqual({})
    r.service.startLogin(ID)
    await vi.advanceTimersByTimeAsync(0)
    expect(session(r.service)!.loginId).not.toBe(loginId)
  })
})

describe('the result', () => {
  it('writes declared secrets, the account and tokenExpiresAt; keeps source / modVersion; drops the keyless mode', async () => {
    const expiresAt = Date.now() + 3_600_000
    const r = rig(async () => ({ secrets: { access_token: 'at-1', refresh_token: 'rt-1' }, account: ' zed@example.com ', expiresAt }), {
      stored: { source: 'mod', modVersion: '2.1.0', credentialMode: 'anonymous', hasApiKey: true, storedSecrets: [], modelEntries: [{ family: 'f', version: '1' }] } as NexusProviderConfig,
    })
    r.service.startLogin(ID)
    await flush()
    expect(session(r.service)!.step).toEqual({ kind: 'done', account: 'zed@example.com' })
    expect(r.writes).toHaveLength(1)
    const written = r.writes[0]!
    expect(written).toMatchObject({
      source: 'mod',
      modVersion: '2.1.0',
      account: 'zed@example.com',
      tokenExpiresAt: Math.floor(expiresAt),
      secrets: { access_token: 'at-1', refresh_token: 'rt-1' },
      modelEntries: [{ family: 'f', version: '1' }],
    })
    expect(written.credentialMode).toBeUndefined()
    // The UI-view fields are never written back.
    expect('hasApiKey' in written).toBe(false)
    expect('storedSecrets' in written).toBe(false)
    expect(written.apiKey).toBeUndefined()
    // A token was stored: the epoch moved and the person is not signed out.
    expect(r.service.epoch(ID)).toBe(1)
    expect(r.service.tokenExpiresAt(ID)).toBe(Math.floor(expiresAt))
  })

  it('a secret the provider does not declare fails the sign-in and writes nothing', async () => {
    const r = rig(async () => ({ secrets: { access_token: 'at', sneaky: 'x' } }))
    r.service.startLogin(ID)
    await flush()
    expect(session(r.service)!.step).toMatchObject({ kind: 'failed', code: 'invalid_result' })
    expect((session(r.service)!.step as { reason: string }).reason).toContain('sneaky')
    expect(r.writes).toHaveLength(0)
  })

  it.each([
    [{ secrets: 'x' }, 'secrets must be an object'],
    [{ secrets: { access_token: 5 } }, 'must be a string'],
    [{ secrets: {}, expiresAt: 1_700_000 }, 'epoch milliseconds'],
    [{ secrets: {}, expiresAt: 'soon' }, 'epoch milliseconds'],
    [{ secrets: {}, account: '' }, 'account'],
    [{ secrets: {}, account: 7 }, 'account'],
    ['yes', 'not an object'],
  ])('refuses an unusable answer %j', async (answer, problem) => {
    const r = rig(async () => answer)
    r.service.startLogin(ID)
    await flush()
    expect(session(r.service)!.step).toMatchObject({ kind: 'failed', code: 'invalid_result' })
    expect((session(r.service)!.step as { reason: string }).reason).toContain(problem)
  })

  it('an account with no secrets and no expiry is a valid sign-in', async () => {
    const r = rig(async () => ({ secrets: {}, account: 'zed' }))
    r.service.startLogin(ID)
    await flush()
    expect(session(r.service)!.step).toEqual({ kind: 'done', account: 'zed' })
    expect(r.writes[0]!.tokenExpiresAt).toBeUndefined()
  })

  it('a failed write is a failed sign-in with its own code', async () => {
    const r = rig(async () => ({ secrets: { access_token: 'at' } }), { writeFails: true })
    r.service.startLogin(ID)
    await flush()
    expect(session(r.service)!.step).toMatchObject({ kind: 'failed', code: 'write_failed' })
  })

  it('the module\'s own failure words reach the dialog; a module that is unavailable or silent is told apart', async () => {
    const words = rig(async e => {
      r1.service.moduleFailed(e.loginId as string, OWN, 'Your account has no plan')
      throw new Error('hook failed')
    })
    const r1 = words
    r1.service.startLogin(ID)
    await flush()
    expect(session(r1.service)!.step).toEqual({ kind: 'failed', code: 'module', reason: 'Your account has no plan' })

    const unavailable = rig(async () => {
      const error = new Error('no window')
      error.name = 'ProviderModUnavailableError'
      throw error
    })
    unavailable.service.startLogin(ID)
    await flush()
    expect(session(unavailable.service)!.step).toMatchObject({ kind: 'failed', code: 'unavailable' })

    const silent = rig(async () => {
      const error = new Error('did not answer')
      error.name = 'ProviderHookUnansweredError'
      throw error
    })
    silent.service.startLogin(ID)
    await flush()
    expect(session(silent.service)!.step).toMatchObject({ kind: 'failed', code: 'unanswered' })
  })

  it('moduleFailed from a module that does not own the login is ignored', async () => {
    const r = rig(async e => {
      r.service.moduleFailed(e.loginId as string, ['mod.other.x'], 'forged')
      throw new Error('real reason')
    })
    r.service.startLogin(ID)
    await flush()
    expect(session(r.service)!.step).toMatchObject({ kind: 'failed', code: 'module', reason: 'real reason' })
  })

  it('no provider.login hook is its own failure', async () => {
    const r = rig(async () => ({}))
    // A runtime that answers `raised: false`.
    const deps = (r.service as unknown as { deps: CredentialDeps }).deps
    deps.runtime = () => ({ hasHook: () => false, call: async () => ({ raised: false }) }) as unknown as CredentialRuntime
    r.service.startLogin(ID)
    await flush()
    expect(session(r.service)!.step).toMatchObject({ kind: 'failed', code: 'no_hook' })
  })
})

describe('parseCredentialResult', () => {
  it('takes an expiry in epoch milliseconds and floors it', () => {
    const parsed = parseCredentialResult({ secrets: {}, expiresAt: 1_900_000_000_000.7 }, [], false)
    expect(parsed).toEqual({ ok: true, result: { secrets: {}, expiresAt: 1_900_000_000_000 } })
  })
  it('a refresh does not answer an account', () => {
    expect(parseCredentialResult({ secrets: {}, account: 'x' }, [], false)).toMatchObject({ ok: false })
  })
})
