/**
 * The router-provider contract (F-27): the `provider.route` row of the event
 * table, the router registry, the boundary check, and the stored routes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkRouteRecipe,
  readRouteRecipe,
  ROUTE_CANDIDATES_MAX,
  ROUTE_LIMIT_MAX,
  ROUTES_MAX,
  sanitizeRouteRecipes,
  type RouteRecipe,
} from '../config/nexusModelConfig/routeRecipes'
import {
  insideRoutesTo,
  providerRouterBoundsFor,
  providerRouterFor,
  registerProviderRouter,
  resetProviderRouters,
  ROUTE_BUDGET_MS,
  ROUTE_HOPS_MAX,
  RouteStopError,
  RouteSwitchError,
  unregisterProviderRouter,
  type ProviderRouter,
} from '../models/drivers/providerRouter'
import {
  isProviderEventName,
  PROVIDER_EVENT_NAMES,
  PROVIDER_EVENTS,
  ROUTER_ONLY_EVENTS,
  WIRE_ONLY_EVENTS,
} from '../mods/provider/providerEvents'
import type { Peer } from '../mods/provider/nouns/providerPeersTypes'
import { normalizeSettings } from '../settings/settingsNormalize'

function recipe(over: Partial<Record<keyof RouteRecipe, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'free-pool',
    name: 'Free pool',
    goal: 'ordered',
    candidates: [
      { provider: 'openrouter', model: 'coder-small:free', limits: { requestsPerMinute: 10, requestsPerDay: 200 } },
      { provider: 'mod.acme.gateway', model: 'coder-large' },
    ],
    order: 'manual',
    switchOn: { limits: true, serverErrors: true, afterReplyStarted: false },
    freeFirst: false,
    stickPerTurn: false,
    ...over,
  }
}

describe('provider.route in the event table', () => {
  it('is a known event with its own budget and is not failed closed by the table', () => {
    expect(isProviderEventName('provider.route')).toBe(true)
    expect(PROVIDER_EVENT_NAMES).toContain('provider.route')
    expect(PROVIDER_EVENTS['provider.route']).toMatchObject({ budgetMs: ROUTE_BUDGET_MS, failClosed: false, void: false })
  })

  it('accepts a target, a stop, or nothing, and refuses any other kind', () => {
    const { accepts } = PROVIDER_EVENTS['provider.route']
    expect(accepts({ provider: 'openrouter', model: 'm' })).toBe(true)
    expect(accepts({ stop: true })).toBe(true)
    expect(accepts(undefined)).toBe(true)
    expect(accepts(null)).toBe(true)
    expect(accepts('openrouter')).toBe(false)
    expect(accepts(['openrouter', 'm'])).toBe(false)
  })

  it('keeps the router-only and wire-only sets apart, each naming known events', () => {
    expect(ROUTER_ONLY_EVENTS).toEqual(['provider.route'])
    for (const name of [...ROUTER_ONLY_EVENTS, ...WIRE_ONLY_EVENTS]) expect(isProviderEventName(name)).toBe(true)
    expect(WIRE_ONLY_EVENTS.filter(name => ROUTER_ONLY_EVENTS.includes(name))).toEqual([])
    // An observer and a lister serve both kinds.
    for (const shared of ['provider.outcome', 'provider.models', 'provider.usage'] as const) {
      expect(ROUTER_ONLY_EVENTS).not.toContain(shared)
      expect(WIRE_ONLY_EVENTS).not.toContain(shared)
    }
  })
})

describe('the router registry', () => {
  afterEach(() => resetProviderRouters())

  const router = (): ProviderRouter => ({ route: async () => undefined })

  it('answers the registered router and its bounds, and nothing for another id', () => {
    const mine = router()
    registerProviderRouter('mod.superrouter.router', mine, { routesTo: '*' })
    expect(providerRouterFor('mod.superrouter.router')).toBe(mine)
    expect(providerRouterBoundsFor('mod.superrouter.router')).toEqual({ routesTo: '*' })
    expect(providerRouterFor('mod.other.router')).toBeUndefined()
    expect(providerRouterBoundsFor('mod.other.router')).toBeUndefined()
  })

  it('an unplug of a replaced registration leaves the newer one in place', () => {
    const first = router()
    const second = router()
    const unplugFirst = registerProviderRouter('mod.a.r', first, { routesTo: ['openrouter'] })
    const unplugSecond = registerProviderRouter('mod.a.r', second, { routesTo: '*' })
    unplugFirst()
    expect(providerRouterFor('mod.a.r')).toBe(second)
    expect(providerRouterBoundsFor('mod.a.r')).toEqual({ routesTo: '*' })
    unplugSecond()
    expect(providerRouterFor('mod.a.r')).toBeUndefined()
  })

  it('unregisters by id', () => {
    registerProviderRouter('mod.a.r', router(), { routesTo: '*' })
    unregisterProviderRouter('mod.a.r')
    expect(providerRouterFor('mod.a.r')).toBeUndefined()
  })

  it('bounds a call to eight targets', () => {
    expect(ROUTE_HOPS_MAX).toBe(8)
  })
})

describe('route errors', () => {
  it('a switch carries the target and the failure it moves off', () => {
    const cause = new Error('socket closed')
    const error = new RouteSwitchError({ provider: 'openrouter', model: 'm', effort: 'high' }, cause)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('RouteSwitchError')
    expect(error.target).toEqual({ provider: 'openrouter', model: 'm', effort: 'high' })
    expect(error.cause).toBe(cause)
    expect(error.message).toBe('socket closed')
  })

  it("a stop carries the router's message, or the failure's when it gave none", () => {
    const cause = new Error('429')
    expect(new RouteStopError(cause, 'every member is used up').message).toBe('every member is used up')
    const bare = new RouteStopError(cause)
    expect(bare.message).toBe('429')
    expect(bare.name).toBe('RouteStopError')
    expect(bare.cause).toBe(cause)
  })
})

describe('insideRoutesTo', () => {
  it('reads the definition, so two instances of one definition are both inside', () => {
    const work: Pick<Peer, 'id' | 'definition'> = { id: 'openrouter', definition: 'openrouter' }
    const personal: Pick<Peer, 'id' | 'definition'> = { id: 'openrouter~2', definition: 'openrouter' }
    const other: Pick<Peer, 'id' | 'definition'> = { id: 'mod.acme.gateway', definition: 'mod.acme.gateway' }
    expect(insideRoutesTo(['openrouter'], work)).toBe(true)
    expect(insideRoutesTo(['openrouter'], personal)).toBe(true)
    expect(insideRoutesTo(['openrouter'], other)).toBe(false)
    // An instance id that is not a definition id does not match by its text.
    expect(insideRoutesTo(['openrouter~2'], personal)).toBe(false)
  })

  it('any provider is inside a router that routes to all', () => {
    expect(insideRoutesTo('*', { definition: 'anything' })).toBe(true)
    expect(insideRoutesTo([], { definition: 'anything' })).toBe(false)
  })
})

describe('route recipes', () => {
  it('reads a well-formed route into a fresh object of the known fields alone', () => {
    const raw = { ...recipe(), extra: 'dropped' }
    const read = readRouteRecipe(raw)
    expect(read).toEqual(recipe())
    expect(read).not.toBe(raw)
    expect(checkRouteRecipe(raw)).toBeNull()
  })

  it('keeps the candidates in the order given, limits on the ones that have them', () => {
    const read = readRouteRecipe(recipe()) as RouteRecipe
    expect(read.candidates.map(c => c.model)).toEqual(['coder-small:free', 'coder-large'])
    expect(read.candidates[0].limits).toEqual({ requestsPerMinute: 10, requestsPerDay: 200 })
    expect('limits' in read.candidates[1]).toBe(false)
  })

  it('treats the same model under two providers as two members, and a repeated pair as a fault', () => {
    const twoProviders = recipe({
      candidates: [
        { provider: 'openrouter', model: 'coder-large' },
        { provider: 'openrouter~2', model: 'coder-large' },
      ],
    })
    expect(checkRouteRecipe(twoProviders)).toBeNull()
    const repeated = recipe({
      candidates: [
        { provider: 'openrouter', model: 'coder-large' },
        { provider: 'openrouter', model: 'coder-large', limits: { requestsPerDay: 5 } },
      ],
    })
    expect(checkRouteRecipe(repeated)).toBe('duplicate-candidate')
  })

  it.each([
    ['zero', { requestsPerMinute: 0 }],
    ['negative', { requestsPerDay: -1 }],
    ['fraction', { tokensPerDay: 1.5 }],
    ['text', { requestsPerDay: '200' }],
    ['past the ceiling', { tokensPerDay: ROUTE_LIMIT_MAX + 1 }],
    ['unknown key', { requestsPerHour: 10 }],
    ['not an object', 5],
  ])('a limit that is %s faults the whole route', (_label, limits) => {
    const raw = recipe({ candidates: [{ provider: 'openrouter', model: 'm', limits }] })
    expect(checkRouteRecipe(raw)).toBe('limits')
  })

  it('an empty limits object is no limits', () => {
    const read = readRouteRecipe(recipe({ candidates: [{ provider: 'openrouter', model: 'm', limits: {} }] })) as RouteRecipe
    expect(read.candidates[0]).toEqual({ provider: 'openrouter', model: 'm' })
  })

  it.each([
    ['shape', 'not a route'],
    ['id', recipe({ id: '' })],
    ['id', recipe({ id: 'has space' })],
    ['id', recipe({ id: 'x'.repeat(65) })],
    ['name', recipe({ name: '   ' })],
    ['goal', recipe({ goal: 'cheapest' })],
    ['candidates', recipe({ candidates: [] })],
    ['candidates', recipe({ candidates: Array.from({ length: ROUTE_CANDIDATES_MAX + 1 }, (_, i) => ({ provider: 'p', model: `m${i}` })) })],
    ['candidate', recipe({ candidates: [{ provider: '', model: 'm' }] })],
    ['candidate', recipe({ candidates: [{ provider: 'p', model: ' m' }] })],
    ['candidate', recipe({ candidates: ['p/m'] })],
    ['order', recipe({ order: 'random' })],
    ['switchOn', recipe({ switchOn: { limits: true, serverErrors: true } })],
    ['flags', recipe({ stickPerTurn: 'no' })],
    ['spend', recipe({ spend: { usdPerDay: 0, whenReached: 'stop' } })],
    ['spend', recipe({ spend: { usdPerDay: 5, whenReached: 'warn' } })],
  ])('names the faulty part: %s', (fault, raw) => {
    expect(checkRouteRecipe(raw)).toBe(fault)
  })

  it('accepts every goal and a spend cap', () => {
    for (const goal of ['same-model', 'free-rotation', 'ordered', 'spread']) {
      expect(checkRouteRecipe(recipe({ goal }))).toBeNull()
    }
    const read = readRouteRecipe(recipe({ spend: { usdPerDay: 2.5, whenReached: 'free-only' } })) as RouteRecipe
    expect(read.spend).toEqual({ usdPerDay: 2.5, whenReached: 'free-only' })
  })

  it('sanitizing drops a faulty route whole, a repeated id, and anything past the cap', () => {
    const good = recipe()
    const uncapped = recipe({ id: 'paid', candidates: [{ provider: 'p', model: 'm', limits: { tokensPerDay: -5 } }] })
    const again = recipe({ name: 'Second with the same id' })
    expect(sanitizeRouteRecipes([good, uncapped, again, null])).toEqual([good])
    expect(sanitizeRouteRecipes('routes')).toEqual([])
    const many = Array.from({ length: ROUTES_MAX + 3 }, (_, i) => recipe({ id: `r${i}` }))
    expect(sanitizeRouteRecipes(many)).toHaveLength(ROUTES_MAX)
  })
})

describe('routes in settings', () => {
  const settings = (routes: unknown) =>
    normalizeSettings({
      version: 1,
      providers: { configs: { 'mod.superrouter.router': { source: 'mod', credentialMode: 'anonymous', routes } } },
    } as never)

  it('survive a normalize, well-formed ones alone', () => {
    const kept = settings([recipe(), recipe({ id: 'bad', goal: 'cheapest' })])
    expect(kept.providers?.configs['mod.superrouter.router'].routes).toEqual([recipe()])
  })

  it('leave no key behind when none is well formed', () => {
    const config = settings([{ id: 'bad' }]).providers?.configs['mod.superrouter.router']
    expect(config).toBeDefined()
    expect(config && 'routes' in config).toBe(false)
  })
})
