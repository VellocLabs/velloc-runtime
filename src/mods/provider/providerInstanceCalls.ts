/**
 * Contract: what a router's settings app may do with the provider instances
 * that router manages (F-27 RP-17): list the definitions and the instances,
 * make an instance, rename one, remove one. Every call is about the bound
 * router's own managed definitions, and the instances it borrowed of the
 * definitions its manifest lists (RP-21), and nothing else: an instance the
 * person set up on the Models page is never one of them.
 *
 * Security: no call takes or returns a secret, a base URL or a token. An
 * instance is made only of a definition that needs no credential here; one
 * that needs a key or a sign-in is refused until the platform's own dialog
 * serves it. The module never chooses an instance id.
 */

import { resolveLocalizedText } from '../../config/localizedText'
import type { NexusProviderConfig } from '../../settings/settingsTypes'
import { defaultInstanceName, planNewInstance, storedInstanceIds } from './providerInstances'
import type { ProviderCredentialMethod, ResolvedProvider } from './providerManifest'

export const INSTANCE_NAME_MAX = 80
export const INSTANCES_PER_DEFINITION_MAX = 16
export const INSTANCES_PER_ROUTER_MAX = 64

/** When the call was made: only a person's action may add or remove. */
export type InstanceCallPhase = 'action' | 'start' | 'other'

export type ManagedDefinition = {
  provider: Pick<ResolvedProvider, 'id' | 'key' | 'manifest'>
  /** The plugin's install identifier: the owner of the instances' entries. */
  owner: string
}

/** A definition of the router's own plugin, or one it borrows from another. */
type RouterDefinition = ManagedDefinition & { borrowedBy?: string }

export type InstanceCallsDeps = {
  /** The definitions `routerId` manages, in manifest order; empty when it is no registered router. */
  managedBy: (routerId: string) => readonly ManagedDefinition[]
  /** The definitions `routerId` borrows and that are there to borrow; absent: none. */
  borrowedBy?: (routerId: string) => readonly ManagedDefinition[]
  configs: () => Readonly<Record<string, NexusProviderConfig>>
  /** The slots of the removed instances of a definition. */
  retiredSlots: (definitionId: string) => Promise<readonly string[]> | readonly string[]
  /** The settings write path: replaces the entry, keeping its sealed values. */
  writeConfig: (providerId: string, config: NexusProviderConfig) => Promise<void>
  /** Removes the entry and its sealed values, and records its slot as given up. */
  removeConfig: (providerId: string) => Promise<void>
  /** Bring the registrations to the stored instances. */
  resync: () => Promise<unknown>
  /** Forget what the platform recorded about an instance's models. */
  forgetState: (providerId: string) => void
  /** Ask the router for its routes again. */
  relist: (routerId: string) => Promise<void>
  isSetUp: (providerId: string) => boolean
  models: (providerId: string) => ReadonlyArray<{ free?: boolean }>
  locale: () => string
  now: () => number
  random?: () => number
}

export type DefinitionRow = {
  /** The key in the router's own manifest; absent on a borrowed definition. */
  key?: string
  id: string
  label: string
  method: ProviderCredentialMethod
  instances: 'single' | 'multiple'
  borrowed?: true
}

export type InstanceRow = {
  id: string
  definition: string
  /** Absent on an instance of a borrowed definition. */
  definitionKey?: string
  borrowed?: true
  name: string
  account?: string
  createdAt: number
  connected: boolean
  signedIn?: true
  modelCount: number
  freeCount: number
}

export type InstanceCallError = { error: { kind: 'single' | 'limit' | 'unsupported' | 'busy'; message: string } }

const notAllowed = (message: string): Error => {
  const error = new Error(message)
  error.name = 'NotAllowedError'
  return error
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The one way a definition's instances are set up; a sign-in before a key before none. */
function methodOf(definition: RouterDefinition): ProviderCredentialMethod {
  const methods = definition.provider.manifest.credentials.methods
  return methods.includes('login') ? 'login' : methods.includes('apiKey') ? 'apiKey' : 'anonymous'
}

function labelOf(definition: RouterDefinition, deps: InstanceCallsDeps): string {
  return resolveLocalizedText(definition.provider.manifest.displayName, deps.locale())
}

/** The router's definitions: the ones it manages, then the ones it borrows. */
function definitionsOf(routerId: string, deps: InstanceCallsDeps): RouterDefinition[] {
  const managed = deps.managedBy(routerId)
  const borrowed = (deps.borrowedBy?.(routerId) ?? [])
    .filter(each => !managed.some(own => own.provider.id === each.provider.id))
    .map(each => ({ ...each, borrowedBy: routerId }))
  return [...managed, ...borrowed]
}

/** The router's instances of a definition: of a borrowed one, only those lent to it. */
function instanceIdsOf(definition: RouterDefinition, deps: InstanceCallsDeps): string[] {
  const holder = definition.borrowedBy !== undefined ? { router: definition.borrowedBy } : ('own' as const)
  return storedInstanceIds(definition.provider.id, definition.owner, deps.configs(), holder)
}

function readName(method: string, value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name.length < 1 || name.length > INSTANCE_NAME_MAX) {
    throw new TypeError(`$.provider.${method}: name must be 1 to ${INSTANCE_NAME_MAX} characters`)
  }
  return name
}

/** The managed instance a call names, with its definition; refused when it is not one of the router's. */
function managedInstance(
  routerId: string,
  method: string,
  args: unknown,
  deps: InstanceCallsDeps,
): { id: string; definition: RouterDefinition; config: NexusProviderConfig } {
  const id = isRecord(args) ? args.provider : undefined
  if (typeof id !== 'string' || id === '') throw new TypeError(`$.provider.${method}: provider must be an instance id`)
  for (const definition of definitionsOf(routerId, deps)) {
    if (!instanceIdsOf(definition, deps).includes(id)) continue
    return { id, definition, config: deps.configs()[id]! }
  }
  throw notAllowed(`$.provider.${method}: ${id} is not an instance of a provider ${routerId} manages or borrowed`)
}

export function listDefinitions(routerId: string, deps: InstanceCallsDeps): DefinitionRow[] {
  return definitionsOf(routerId, deps).map(definition =>
    definition.borrowedBy !== undefined
      ? {
          id: definition.provider.id,
          label: labelOf(definition, deps),
          method: methodOf(definition),
          instances: 'multiple' as const,
          borrowed: true as const,
        }
      : {
          key: definition.provider.key,
          id: definition.provider.id,
          label: labelOf(definition, deps),
          method: methodOf(definition),
          instances: definition.provider.manifest.instances === 'multiple' ? ('multiple' as const) : ('single' as const),
        },
  )
}

export function listInstances(routerId: string, deps: InstanceCallsDeps): InstanceRow[] {
  const configs = deps.configs()
  return definitionsOf(routerId, deps).flatMap(definition =>
    instanceIdsOf(definition, deps).map(id => {
      const config = configs[id]!
      const models = deps.models(id)
      return {
        id,
        definition: definition.provider.id,
        ...(definition.borrowedBy !== undefined ? { borrowed: true as const } : { definitionKey: definition.provider.key }),
        name: config.name ?? labelOf(definition, deps),
        ...(config.account ? { account: config.account } : {}),
        createdAt: config.createdAt ?? 0,
        connected: deps.isSetUp(id),
        ...(config.signedIn ? { signedIn: true as const } : {}),
        modelCount: models.length,
        freeCount: models.filter(model => model.free === true).length,
      }
    }),
  )
}

/**
 * Serves the calls of one runtime. `add` and `remove` change what is stored,
 * so one runs at a time per router; a second is answered `busy`. A rename
 * waits for them, so it never writes back an instance just removed.
 */
export function createInstanceCalls(deps: InstanceCallsDeps) {
  const busy = new Set<string>()
  const tails = new Map<string, Promise<unknown>>()

  function inSeries<T>(routerId: string, run: () => Promise<T>): Promise<T> {
    const next = (tails.get(routerId) ?? Promise.resolve()).then(run)
    const tail = next.catch(() => undefined)
    tails.set(routerId, tail)
    void tail.then(() => {
      if (tails.get(routerId) === tail) tails.delete(routerId)
    })
    return next
  }

  async function exclusive<T>(routerId: string, method: string, run: () => Promise<T>): Promise<T | InstanceCallError> {
    if (busy.has(routerId)) {
      return { error: { kind: 'busy', message: `$.provider.${method}: another instance of ${routerId} is being added or removed` } }
    }
    busy.add(routerId)
    try {
      return await inSeries(routerId, run)
    } finally {
      busy.delete(routerId)
    }
  }

  /** After the stored instances changed: register them, then the router's routes. */
  async function settle(routerId: string): Promise<void> {
    await deps.resync()
    await deps.relist(routerId).catch(() => undefined)
  }

  async function add(routerId: string, args: unknown, phase: InstanceCallPhase): Promise<{ id: string } | InstanceCallError> {
    if (!isRecord(args) || typeof args.definition !== 'string' || args.definition === '') {
      throw new TypeError('$.provider.addInstance({ definition, name? }): definition must be the key or the id of a managed definition')
    }
    const managed = definitionsOf(routerId, deps)
    // A key names a definition of the router's own manifest; a borrowed one is named by its id.
    const definition = managed.find(
      each => each.provider.id === args.definition || (each.borrowedBy === undefined && each.provider.key === args.definition),
    )
    if (!definition) {
      throw notAllowed(`$.provider.addInstance: ${args.definition} is not a provider ${routerId} manages or may borrow`)
    }
    const method = methodOf(definition)
    // Security: a model's turn or a timer never adds a provider; the one
    // exception needs no credential and no consent beyond the plugin's.
    if (phase !== 'action' && !(phase === 'start' && method === 'anonymous')) {
      throw notAllowed('$.provider.addInstance: only while handling an action of the person (app.action)')
    }
    const named = args.name === undefined ? undefined : readName('addInstance', args.name)
    if (method !== 'anonymous') {
      return {
        error: {
          kind: 'unsupported',
          message: `$.provider.addInstance: ${definition.provider.id} needs ${method === 'login' ? 'a sign-in' : 'a key'}, which this Velloc cannot ask for from an app yet`,
        },
      }
    }
    return exclusive(routerId, 'addInstance', async () => {
      const instances = instanceIdsOf(definition, deps)
      const total = managed.reduce((sum, each) => sum + instanceIdsOf(each, deps).length, 0)
      if (instances.length >= INSTANCES_PER_DEFINITION_MAX || total >= INSTANCES_PER_ROUTER_MAX) {
        const message =
          instances.length >= INSTANCES_PER_DEFINITION_MAX
            ? `${definition.provider.id} has ${INSTANCES_PER_DEFINITION_MAX} instances, the most one provider may have`
            : `${routerId} manages ${INSTANCES_PER_ROUTER_MAX} instances, the most one router may manage`
        return { error: { kind: 'limit' as const, message } }
      }
      const configs = deps.configs()
      const label = labelOf(definition, deps)
      const usedNames = instances.map(id => configs[id]?.name ?? label)
      const plan = planNewInstance({
        definition: definition.provider,
        owner: definition.owner,
        // Every instance of the definition holds its slot, whoever set it up.
        instances: storedInstanceIds(definition.provider.id, definition.owner, configs),
        ...(definition.borrowedBy !== undefined ? { lentTo: definition.borrowedBy } : {}),
        retiredSlots: await deps.retiredSlots(definition.provider.id),
        name: named ?? defaultInstanceName(label, method, usedNames),
        now: deps.now(),
        ...(deps.random ? { random: deps.random } : {}),
      })
      if (!plan.ok) return { error: { kind: 'single' as const, message: plan.message } }
      await deps.writeConfig(plan.id, { ...plan.config, credentialMode: 'anonymous' })
      await settle(routerId)
      return { id: plan.id }
    })
  }

  async function rename(routerId: string, args: unknown): Promise<{ ok: true }> {
    managedInstance(routerId, 'renameInstance', args, deps)
    const name = readName('renameInstance', (args as Record<string, unknown>).name)
    return inSeries(routerId, async () => {
      const { id, config } = managedInstance(routerId, 'renameInstance', args, deps)
      // The write path keeps the stored key when none is sent.
      const { apiKey: _key, hasApiKey: _flag, ...rest } = config
      await deps.writeConfig(id, { ...rest, name })
      return { ok: true as const }
    })
  }

  async function remove(routerId: string, args: unknown, phase: InstanceCallPhase): Promise<{ ok: true } | InstanceCallError> {
    if (phase !== 'action') throw notAllowed('$.provider.removeInstance: only while handling an action of the person (app.action)')
    const { id } = managedInstance(routerId, 'removeInstance', args, deps)
    return exclusive(routerId, 'removeInstance', async () => {
      await deps.removeConfig(id)
      deps.forgetState(id)
      await settle(routerId)
      return { ok: true as const }
    })
  }

  return {
    definitions: (routerId: string) => listDefinitions(routerId, deps),
    instances: (routerId: string) => listInstances(routerId, deps),
    add,
    rename,
    remove,
  }
}

export type InstanceCalls = ReturnType<typeof createInstanceCalls>
