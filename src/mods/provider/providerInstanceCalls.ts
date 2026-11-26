/**
 * Contract: what a router's settings app may do with the provider instances
 * that router manages (F-27 RP-17): list the definitions and the instances,
 * make an instance, rename one, remove one. Every call is about the bound
 * router's own managed definitions, and the instances it borrowed of the
 * definitions its manifest lists (RP-21), and nothing else: an instance the
 * person set up on the Models page is never one of them.
 *
 * Security: no call takes or returns a secret, a base URL or a token. A
 * definition that needs a key gets it from the person in the platform's own
 * dialog (RP-22): the key goes from that dialog to the settings write path
 * and the module sees only whether an instance was made. A definition that
 * needs a sign-in is refused until that dialog serves it. The module never
 * chooses an instance id.
 */

import { resolveLocalizedText, type LocalizedText } from '../../config/localizedText'
import type { NexusProviderConfig } from '../../settings/settingsTypes'
import type { KeyAsked, KeyRequestAbout, KeyTaken } from './keyRequest/providerKeyRequests'
import { defaultInstanceName, planNewInstance, storedInstanceIds } from './providerInstances'
import { MOD_PROVIDER_ID_PREFIX, type ProviderCredentialMethod, type ResolvedProvider } from './providerManifest'

export const INSTANCE_NAME_MAX = 80
export const INSTANCES_PER_DEFINITION_MAX = 16
export const INSTANCES_PER_ROUTER_MAX = 64

/** When the call was made: only a person's action may add or remove. */
export type InstanceCallPhase = 'action' | 'start' | 'other'

/** How a call that waits for the person is held and ended. */
export type InstanceCallWaiting = {
  /** Runs the wait with the calling hook's clock standing still. */
  whileAsking?: <T>(work: () => Promise<T>) => Promise<T>
  /** Aborts when the calling hook or its module is gone. */
  signal?: AbortSignal
}

/** What is asked of the person: which provider, in whose name. */
export type KeyQuestion = KeyRequestAbout
/** What became of a key: the call's answer, and what the dialog says when no instance was made. */
export type KeyStored<T> = KeyTaken<T>

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
  /** A definition's brand mark as an image URL, if it has one. */
  icon?: (definitionId: string) => string | undefined
  locale: () => string
  now: () => number
  random?: () => number
  /**
   * Security: asks the person for a key in the platform's dialog and hands
   * it to `take`, which is the only code that sees it. Absent: a definition
   * that needs a key is answered `unsupported`.
   */
  askKey?: <T>(
    question: KeyQuestion,
    take: (key: string) => Promise<KeyStored<T>>,
    signal?: AbortSignal,
  ) => Promise<KeyAsked<T>>
  /** A router's name, for the dialog; absent or undefined: its id is shown. */
  routerLabel?: (routerId: string) => LocalizedText | undefined
  /** The platform's fingerprint of a key for a definition; undefined when none can be made. */
  fingerprint?: (definitionId: string, key: string) => Promise<string | undefined>
  /** Check a just-stored key against the provider. Not waited for; its result is the instance's state. */
  verify?: (providerId: string) => Promise<unknown>
}

export type DefinitionRow = {
  /** The key in the router's own manifest; absent on a borrowed definition. */
  key?: string
  id: string
  label: string
  icon?: string
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

export type InstanceCallError = {
  error: {
    kind: 'single' | 'limit' | 'unsupported' | 'busy' | 'duplicate'
    message: string
    /** On `duplicate`: the provider or instance that already has the key, and its name. */
    existing?: string
    name?: string
  }
}

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

/**
 * Whether the platform's dialog can set the definition up: its one field is
 * the key. A definition with named secrets, prompts of its own beyond the
 * key's wording, or settings the person fills in is not served yet.
 */
function needsOnlyKey(definition: RouterDefinition): boolean {
  const { credentials, settings } = definition.provider.manifest
  const prompts = credentials.prompts ?? []
  const keyPromptOnly = prompts.length === 0 || (prompts.length === 1 && prompts[0]!.key === 'api_key' && prompts[0]!.type === 'text')
  const filledIn = Object.values(settings ?? {}).some(field => field.binds === undefined)
  return keyPromptOnly && (credentials.secrets ?? []).length === 0 && !filledIn
}

/** The plugin of a definition id, `mod.<plugin>.<key>`. */
function pluginOf(definitionId: string): string {
  return definitionId.slice(MOD_PROVIDER_ID_PREFIX.length).split('.')[0] ?? definitionId
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

function iconOf(definition: ManagedDefinition, deps: InstanceCallsDeps): { icon?: string } {
  const icon = deps.icon?.(definition.provider.id)
  return icon !== undefined ? { icon } : {}
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
          ...iconOf(definition, deps),
          method: methodOf(definition),
          instances: 'multiple' as const,
          borrowed: true as const,
        }
      : {
          key: definition.provider.key,
          id: definition.provider.id,
          label: labelOf(definition, deps),
          ...iconOf(definition, deps),
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

  /** Why no instance of `definition` can be made now, if so. */
  function refusal(routerId: string, definition: RouterDefinition, managed: readonly RouterDefinition[]): InstanceCallError | undefined {
    const instances = instanceIdsOf(definition, deps)
    const total = managed.reduce((sum, each) => sum + instanceIdsOf(each, deps).length, 0)
    if (instances.length >= INSTANCES_PER_DEFINITION_MAX || total >= INSTANCES_PER_ROUTER_MAX) {
      const message =
        instances.length >= INSTANCES_PER_DEFINITION_MAX
          ? `${definition.provider.id} has ${INSTANCES_PER_DEFINITION_MAX} instances, the most one provider may have`
          : `${routerId} manages ${INSTANCES_PER_ROUTER_MAX} instances, the most one router may manage`
      return { error: { kind: 'limit', message } }
    }
    const { manifest, id } = definition.provider
    if (definition.borrowedBy === undefined && manifest.instances !== 'multiple' && instances.length > 0) {
      return { error: { kind: 'single', message: `${id} allows one instance and has one (its manifest does not say "instances": "multiple")` } }
    }
    return undefined
  }

  /** Stores one more instance of `definition` with the given credential. Runs in the router's series. */
  async function makeOne(
    routerId: string,
    definition: RouterDefinition,
    managed: readonly RouterDefinition[],
    named: string | undefined,
    credential: { credentialMode: 'anonymous' } | { apiKey: string },
  ): Promise<{ id: string } | InstanceCallError> {
    const refused = refusal(routerId, definition, managed)
    if (refused) return refused
    const configs = deps.configs()
    const label = labelOf(definition, deps)
    const usedNames = instanceIdsOf(definition, deps).map(id => configs[id]?.name ?? label)
    const plan = planNewInstance({
      definition: definition.provider,
      owner: definition.owner,
      // Every instance of the definition holds its slot, whoever set it up.
      instances: storedInstanceIds(definition.provider.id, definition.owner, configs),
      ...(definition.borrowedBy !== undefined ? { lentTo: definition.borrowedBy } : {}),
      retiredSlots: await deps.retiredSlots(definition.provider.id),
      name: named ?? defaultInstanceName(label, methodOf(definition), usedNames),
      now: deps.now(),
      ...(deps.random ? { random: deps.random } : {}),
    })
    if (!plan.ok) return { error: { kind: 'single' as const, message: plan.message } }
    await deps.writeConfig(plan.id, { ...plan.config, ...credential })
    await settle(routerId)
    return { id: plan.id }
  }

  /**
   * The provider or instance of the definition that already holds `key`:
   * the person's own on the Models page, or any instance, whoever it is
   * lent to. Told by the platform's fingerprint, so one stored before
   * fingerprints were kept is not found.
   */
  async function holderOf(definition: RouterDefinition, key: string): Promise<{ id: string; name: string } | undefined> {
    const { id } = definition.provider
    const fingerprint = await deps.fingerprint?.(id, key)
    if (fingerprint === undefined) return undefined
    const configs = deps.configs()
    const holder = [id, ...storedInstanceIds(id, definition.owner, configs)].find(each => configs[each]?.secretFingerprint === fingerprint)
    return holder === undefined ? undefined : { id: holder, name: configs[holder]?.name ?? labelOf(definition, deps) }
  }

  async function addWithKey(
    routerId: string,
    definition: RouterDefinition,
    managed: readonly RouterDefinition[],
    named: string | undefined,
    waiting: InstanceCallWaiting,
  ): Promise<{ id: string } | { cancelled: true } | InstanceCallError> {
    const { askKey } = deps
    const { id, manifest } = definition.provider
    if (!askKey || !needsOnlyKey(definition)) {
      const why = askKey ? 'more than a key, which this Velloc cannot ask for from an app yet' : 'a key, which this Velloc cannot ask for from an app here'
      return { error: { kind: 'unsupported', message: `$.provider.addInstance: ${id} needs ${why}` } }
    }
    if (busy.has(routerId)) {
      return { error: { kind: 'busy', message: `$.provider.addInstance: another instance of ${routerId} is being added or removed` } }
    }
    // Held for as long as the dialog is open: one question at a time per router.
    busy.add(routerId)
    try {
      const early = refusal(routerId, definition, managed)
      if (early) return early
      const prompt = manifest.credentials.prompts?.[0]?.message
      const routerLabel = deps.routerLabel?.(routerId)
      const question: KeyQuestion = {
        routerId,
        ...(routerLabel !== undefined ? { routerLabel } : {}),
        plugin: pluginOf(id),
        definitionId: id,
        label: manifest.displayName,
        ...(prompt !== undefined ? { prompt } : {}),
      }
      // Security: the key is read here and by the write path, nowhere else.
      const take = (key: string): Promise<KeyStored<{ id: string } | InstanceCallError>> =>
        inSeries(routerId, async () => {
          const holder = await holderOf(definition, key)
          if (holder) {
            const message = `$.provider.addInstance: this key is already the key of ${holder.name} (${holder.id})`
            return {
              value: { error: { kind: 'duplicate' as const, message, existing: holder.id, name: holder.name } },
              problem: { kind: 'duplicate' as const, name: holder.name },
            }
          }
          const made = await makeOne(routerId, definition, managed, named, { apiKey: key })
          if ('error' in made) return { value: made, problem: { kind: 'failed' as const } }
          void deps.verify?.(made.id).catch(() => undefined)
          return { value: made }
        })
      const ask = () => askKey(question, take, waiting.signal)
      const outcome = await (waiting.whileAsking ? waiting.whileAsking(ask) : ask())
      return 'cancelled' in outcome ? { cancelled: true } : outcome.answered
    } finally {
      busy.delete(routerId)
    }
  }

  async function add(
    routerId: string,
    args: unknown,
    phase: InstanceCallPhase,
    waiting: InstanceCallWaiting = {},
  ): Promise<{ id: string } | { cancelled: true } | InstanceCallError> {
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
    if (method === 'login') {
      return {
        error: {
          kind: 'unsupported',
          message: `$.provider.addInstance: ${definition.provider.id} needs a sign-in, which this Velloc cannot ask for from an app yet`,
        },
      }
    }
    if (method === 'apiKey') return addWithKey(routerId, definition, managed, named, waiting)
    return exclusive(routerId, 'addInstance', () => makeOne(routerId, definition, managed, named, { credentialMode: 'anonymous' }))
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
