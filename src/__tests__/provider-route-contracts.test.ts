/**
 * The router-provider contract (F-27): the `provider.route` row of the event
 * table, the router registry, and the boundary check.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  insideRoutesTo,
  providerRouterBoundsFor,
  providerRouterFor,
  registerProviderRouter,
  resetProviderRouters,
  ROUTE_BUDGET_MS,
  ROUTE_SENDS_PER_TARGET,
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

  it('gives a call four target answers for each distinct target named', () => {
    expect(ROUTE_SENDS_PER_TARGET).toBe(4)
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

describe('a stored routes list', () => {
  it('is not a provider config field: a normalize drops it', () => {
    const kept = normalizeSettings({
      version: 1,
      providers: {
        configs: {
          'mod.superrouter.router': { source: 'mod', credentialMode: 'anonymous', routes: [{ id: 'pool' }] },
        },
      },
    } as never)
    const config = kept.providers?.configs['mod.superrouter.router']
    expect(config).toMatchObject({ source: 'mod', credentialMode: 'anonymous' })
    expect(config && 'routes' in config).toBe(false)
  })
})
