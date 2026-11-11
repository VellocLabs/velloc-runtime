/**
 * Provider mods (F-27): the `providers.<key>.jobs` block. What is accepted,
 * what refuses the provider and with which words, and the platform's range
 * for the figures a job declares.
 */
import { describe, expect, it } from 'vitest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import {
  PROVIDER_JOB_DEFAULT_BUDGET_MS,
  PROVIDER_JOB_MAX_BUDGET_MS,
  PROVIDER_JOB_MAX_EVERY_MS,
  PROVIDER_JOB_MIN_BUDGET_MS,
  PROVIDER_JOB_MIN_EVERY_MS,
  checkProviderJobs,
  effectiveJobTiming,
} from '../mods/provider/providerJobsManifest'

function check(over: Record<string, unknown> = {}) {
  const { manifest, errors } = checkPluginDescriptor({
    name: 'acme',
    version: '1.0.0',
    providers: {
      zen: {
        providerApi: 1,
        displayName: 'Acme Zen',
        defaultBaseUrl: 'https://api.acme.example/v1',
        domains: ['acme.example'],
        format: 'google',
        credentials: { methods: ['apiKey'] },
        module: './providers/zen.js',
        ...over,
      },
    },
  })
  return { provider: manifest?.providers?.zen, errors }
}

const PROBE = { id: 'probe', everyMs: 1_800_000, budgetMs: 20_000, runOn: ['connect'], requires: ['online'] }
const ID_RULE = 'required; 1-32 characters of letters, digits, "_" and "-"'
const EVERY_RULE = 'required; a positive whole number of milliseconds'

describe('providers.<key>.jobs', () => {
  it('keeps a declared job as written', () => {
    const { provider, errors } = check({ jobs: [PROBE, { id: 'sweep_2', everyMs: 600_000 }] })
    expect(errors).toEqual([])
    expect(provider?.jobs).toEqual([PROBE, { id: 'sweep_2', everyMs: 600_000 }])
  })

  it('a provider without the block, or with an empty one, is what it was', () => {
    const plain = check()
    expect(plain.errors).toEqual([])
    expect(plain.provider).toBeDefined()
    expect('jobs' in plain.provider!).toBe(false)
    const empty = check({ jobs: [] })
    expect(empty.errors).toEqual([])
    expect(empty.provider).toEqual(plain.provider)
  })

  it('an unknown field beside the block is still ignored', () => {
    const { provider, errors } = check({ jobs: [PROBE], somethingNewer: { a: 1 } })
    expect(errors).toEqual([])
    expect(provider?.jobs).toHaveLength(1)
  })

  it.each([
    ['not a list', { probe: PROBE }, 'jobs: expected a list'],
    ['more than four', [1, 2, 3, 4, 5].map(n => ({ id: `j${n}`, everyMs: 600_000 })), 'jobs: 5 jobs declared; the most is 4'],
    ['an entry that is not an object', ['probe'], 'jobs[0]: expected an object'],
    ['an unknown property', [{ ...PROBE, intervalMs: 5 }], 'jobs[0]: unknown property "intervalMs"'],
    ['no id', [{ everyMs: 600_000 }], `jobs[0].id: ${ID_RULE}`],
    ['an id with a space', [{ id: 'probe now', everyMs: 600_000 }], `jobs[0].id: ${ID_RULE}`],
    [
      'an id twice',
      [
        { id: 'probe', everyMs: 600_000 },
        { id: 'probe', everyMs: 900_000 },
      ],
      'jobs[1].id: "probe" is declared twice',
    ],
    ['no interval', [{ id: 'probe' }], `jobs[0].everyMs: ${EVERY_RULE}`],
    ['an interval as text', [{ id: 'probe', everyMs: '30m' }], `jobs[0].everyMs: ${EVERY_RULE}`],
    ['a zero interval', [{ id: 'probe', everyMs: 0 }], `jobs[0].everyMs: ${EVERY_RULE}`],
    [
      'a fractional budget',
      [{ id: 'probe', everyMs: 600_000, budgetMs: 1.5 }],
      'jobs[0].budgetMs: expected a positive whole number of milliseconds',
    ],
    ['runOn that is not a list', [{ id: 'probe', everyMs: 600_000, runOn: 'connect' }], 'jobs[0].runOn: expected a list'],
    [
      'an unknown runOn word',
      [{ id: 'probe', everyMs: 600_000, runOn: ['connect', 'startup'] }],
      'jobs[0].runOn: "startup" is not known to this Velloc (it knows connect)',
    ],
    [
      'an unknown requirement',
      [{ id: 'probe', everyMs: 600_000, requires: ['onlin'] }],
      'jobs[0].requires: "onlin" is not known to this Velloc (it knows online)',
    ],
  ])('refuses the provider for %s', (_name, jobs, message) => {
    const { provider, errors } = check({ jobs })
    expect(provider).toBeUndefined()
    expect(errors.some(line => line.endsWith(`providers.zen.${message}`))).toBe(true)
  })

  it('reports every problem of a block and returns no jobs', () => {
    const problems: string[] = []
    const jobs = checkProviderJobs(
      [
        { id: 'ok', everyMs: 600_000 },
        { id: '', everyMs: -1, extra: true },
      ],
      message => problems.push(message),
    )
    expect(jobs).toBeUndefined()
    expect(problems).toHaveLength(3)
  })

  it('figures outside the range are accepted and clamped, never refused', () => {
    const { provider, errors } = check({ jobs: [{ id: 'eager', everyMs: 1_000, budgetMs: 600_000 }] })
    expect(errors).toEqual([])
    expect(provider?.jobs).toEqual([{ id: 'eager', everyMs: 1_000, budgetMs: 600_000 }])
    expect(effectiveJobTiming(provider!.jobs![0]!)).toEqual({
      everyMs: PROVIDER_JOB_MIN_EVERY_MS,
      budgetMs: PROVIDER_JOB_MAX_BUDGET_MS,
      clamped: true,
    })
    expect(PROVIDER_JOB_MIN_EVERY_MS).toBe(300_000)
    expect(PROVIDER_JOB_MAX_BUDGET_MS).toBe(60_000)
    expect(effectiveJobTiming({ everyMs: Number.MAX_SAFE_INTEGER, budgetMs: 1 })).toEqual({
      everyMs: PROVIDER_JOB_MAX_EVERY_MS,
      budgetMs: PROVIDER_JOB_MIN_BUDGET_MS,
      clamped: true,
    })
    expect(effectiveJobTiming({ everyMs: 1_800_000 })).toEqual({
      everyMs: 1_800_000,
      budgetMs: PROVIDER_JOB_DEFAULT_BUDGET_MS,
      clamped: false,
    })
  })
})
