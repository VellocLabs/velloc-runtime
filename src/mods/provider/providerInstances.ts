/**
 * Contract: the instances of a provider definition (F-27 RP-16). A definition
 * is a `providers` entry of a plugin's manifest; an instance is one time the
 * person set it up, with its own id, credentials, picks and state. The
 * definition's own id is its first instance; each further one is
 * `<definition id>.<slot>`, stored in settings.json with `definition` naming
 * what it belongs to. A definition a router manages (`managedBy`) has no
 * first instance under its own id: every instance of it is a stored one.
 *
 * An instance id is opaque. `instanceSlotOf` is the one reader of its text,
 * and it is used to check a stored id, never to learn what an instance
 * belongs to: that is the stored `definition`.
 */

import type { NexusProviderConfig } from '../../settings/settingsTypes'
import {
  INSTANCE_ID_RESERVE,
  INSTANCE_SLOT,
  PROVIDER_ID_MAX_LENGTH,
  type ProviderCredentialMethod,
  type ResolvedProvider,
} from './providerManifest'

const SLOT_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const NEW_SLOT_LENGTH = 4
/** Past this many draws at one length a slot is drawn one character longer. */
const DRAWS_PER_LENGTH = 32

export function providerInstanceId(definitionId: string, slot: string): string {
  return `${definitionId}.${slot}`
}

/** The slot of `id` when it is shaped as an instance of `definitionId`. */
export function instanceSlotOf(definitionId: string, id: string): string | undefined {
  if (!id.startsWith(`${definitionId}.`) || id.length > PROVIDER_ID_MAX_LENGTH) return undefined
  const slot = id.slice(definitionId.length + 1)
  return INSTANCE_SLOT.test(slot) ? slot : undefined
}

/**
 * A slot no instance of the definition has or had. `taken` holds the slots
 * in use and the ones given up: a slot is never given out twice, so what was
 * kept under a removed instance's id is never read by a later one.
 */
export function newInstanceSlot(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (let length = NEW_SLOT_LENGTH; length < INSTANCE_ID_RESERVE; length += 1) {
    for (let draw = 0; draw < DRAWS_PER_LENGTH; draw += 1) {
      let slot = ''
      for (let i = 0; i < length; i += 1) slot += SLOT_CHARS[Math.floor(random() * SLOT_CHARS.length) % SLOT_CHARS.length]
      if (!taken.has(slot)) return slot
    }
  }
  throw new Error('no instance slot is free')
}

/**
 * The stored instances of `definitionId` beyond the first, oldest first.
 * Security: an entry counts only when it names the definition, is the
 * owner's and carries an id the platform could have given out, so a
 * hand-written entry cannot attach itself to another plugin's provider.
 */
export function storedInstanceIds(
  definitionId: string,
  owner: string,
  configs: Readonly<Record<string, NexusProviderConfig>>,
): string[] {
  return Object.entries(configs)
    .filter(
      ([id, config]) =>
        config.definition === definitionId &&
        config.source === 'mod' &&
        config.modOwner === owner &&
        instanceSlotOf(definitionId, id) !== undefined,
    )
    .sort(([a, x], [b, y]) => (x.createdAt ?? 0) - (y.createdAt ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([id]) => id)
}

/** How many stored instances of a definition are registered. */
function storedInstanceLimit(provider: ResolvedProvider): number {
  if (provider.manifest.instances === 'multiple') return Number.POSITIVE_INFINITY
  return provider.manifest.managedBy !== undefined ? 1 : 0
}

/**
 * A plugin's providers with one entry per instance: each definition as it
 * is (its first instance; none for a managed definition), then its stored
 * instances, as many as it allows, oldest first. A stored instance beyond
 * that is left out and reported.
 */
export function withStoredInstances(
  providers: readonly ResolvedProvider[],
  owner: string,
  configs: Readonly<Record<string, NexusProviderConfig>>,
  report: (line: string) => void = () => {},
): ResolvedProvider[] {
  const out: ResolvedProvider[] = []
  for (const provider of providers) {
    if (provider.manifest.managedBy === undefined) out.push(provider)
    const stored = storedInstanceIds(provider.id, owner, configs)
    const limit = storedInstanceLimit(provider)
    const extra = stored.slice(limit)
    if (extra.length > 0) report(`${provider.id}: ${extra.join(', ')} not registered: the provider allows one instance`)
    for (const id of stored.slice(0, limit)) out.push({ ...provider, id, definition: provider.id })
  }
  return out
}

/**
 * The name a new instance starts with. A sign-in is told apart by its
 * account; anything else by a number once the plain name is in use.
 */
export function defaultInstanceName(
  label: string,
  method: ProviderCredentialMethod,
  usedNames: readonly string[],
  account?: string,
): string {
  if (method === 'login' && account) return `${label} · ${account}`
  if (method === 'anonymous' || !usedNames.includes(label)) return label
  for (let n = 2; ; n += 1) {
    const name = `${label} ${n}`
    if (!usedNames.includes(name)) return name
  }
}

export type NewInstancePlan =
  | { ok: true; id: string; config: NexusProviderConfig }
  | { ok: false; reason: 'single' | 'router'; message: string }

/**
 * What making one more instance of `definition` would store, or why it is
 * refused. Nothing is written here. `instances` are the definition's present
 * instance ids; `retiredSlots` the slots of the ones removed.
 */
export function planNewInstance(input: {
  definition: Pick<ResolvedProvider, 'id' | 'manifest'>
  owner: string
  instances: readonly string[]
  retiredSlots?: readonly string[]
  name: string
  now: number
  random?: () => number
}): NewInstancePlan {
  const { definition } = input
  if (definition.manifest.kind === 'router') {
    return { ok: false, reason: 'router', message: `${definition.id} is a router: it has one instance` }
  }
  if (definition.manifest.instances !== 'multiple' && input.instances.length > 0) {
    return {
      ok: false,
      reason: 'single',
      message: `${definition.id} allows one instance and has one (its manifest does not say "instances": "multiple")`,
    }
  }
  const taken = new Set(input.retiredSlots ?? [])
  for (const id of input.instances) {
    const slot = instanceSlotOf(definition.id, id)
    if (slot !== undefined) taken.add(slot)
  }
  const id = providerInstanceId(definition.id, newInstanceSlot(taken, input.random))
  return {
    ok: true,
    id,
    config: { source: 'mod', modOwner: input.owner, definition: definition.id, name: input.name, createdAt: input.now },
  }
}
