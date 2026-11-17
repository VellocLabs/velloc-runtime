/**
 * A mod failure as data (F-25): which plugin, what failed, why, and where in
 * its source. The runtime fills every field but `reason`; `reason` is the
 * mod's own error text and is untrusted.
 */

import type { ModFaultsAttachment } from '../runtime/RuntimeTypes'

/** `hook`: a hook threw or ran out of time; `load`: the module did not load;
 *  `runtime`: anything else the module's worker reported (a timer callback). */
export type ModFaultKind = 'hook' | 'load' | 'runtime'

export type ModFault = {
  plugin: string
  /** `<name>@<marketplace>`; `@dev` for the session dev mods folder. */
  provenance?: string
  /** The load generation the failure belongs to. */
  generation: number
  kind: ModFaultKind
  /** The event a failed hook ran on (`hook` only). */
  event?: string
  /** A hook out of its time budget rather than one that threw. */
  timeout?: true
  /** Untrusted: the mod's error text, or the runtime's reason for a load. */
  reason: string
  /** Source file and 1-based line, when the runtime could tell. */
  file?: string
  line?: number
}

/** A fault from the session's dev mods folder. */
export const isDevModFault = (fault: Pick<ModFault, 'provenance'>): boolean =>
  fault.provenance?.endsWith('@dev') === true

/** At most this many characters of a reason travel on. */
export const MOD_FAULT_REASON_MAX = 500
/** At most this many faults a batch carries; the rest are counted. */
export const MOD_FAULT_BATCH_MAX = 5

/** A batch handed on: the faults, and how many more were left out. */
export type ModFaultBatch = { faults: ModFault[]; omitted: number }

export type ModFaultLedger = {
  /** Keeps `fault` for the next batch. False when the same plugin, load and
   *  kind (and event) was noted already: one line per failure, not a flood. */
  note(fault: ModFault): boolean
  /** The faults not handed on yet, oldest first. */
  pending(): readonly ModFault[]
  /** Hands the pending faults on (at most `MOD_FAULT_BATCH_MAX`) and clears them. */
  take(): ModFaultBatch | undefined
}

/** One line of text, at most `max` characters, control characters spaced. */
export function boundReason(reason: string, max = MOD_FAULT_REASON_MAX): string {
  // eslint-disable-next-line no-control-regex
  const flat = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const keyOf = (fault: ModFault): string =>
  [fault.plugin, fault.generation, fault.kind, fault.event ?? ''].join('\u0000')

export function createModFaultLedger(): ModFaultLedger {
  const seen = new Set<string>()
  let queue: ModFault[] = []
  let omitted = 0
  return {
    note(fault) {
      const key = keyOf(fault)
      if (seen.has(key)) return false
      seen.add(key)
      const kept = { ...fault, reason: boundReason(fault.reason) }
      if (queue.length >= MOD_FAULT_BATCH_MAX) omitted += 1
      else queue.push(kept)
      return true
    },
    pending: () => queue,
    take() {
      if (queue.length === 0 && omitted === 0) return undefined
      const batch = { faults: queue, omitted }
      queue = []
      omitted = 0
      return batch
    },
  }
}

/** The row a batch travels in, as the model and the transcript read it. */
export function modFaultsAttachmentOf(batch: ModFaultBatch | undefined): ModFaultsAttachment | undefined {
  if (!batch) return undefined
  return {
    type: 'mod_faults',
    faults: batch.faults.map(({ plugin, kind, event, timeout, reason, file, line }) => ({
      plugin,
      kind,
      ...(event !== undefined ? { event } : {}),
      ...(timeout ? { timeout } : {}),
      reason,
      ...(file !== undefined ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
    })),
    omitted: batch.omitted,
  }
}

/** Whether a stored row is a `mod_faults` reminder. Security: such a row
 *  does not pass other mods' `session.append` hooks. */
export function isModFaultsRow(row: unknown): boolean {
  const attachment = (row as { type?: unknown; attachment?: { type?: unknown } } | null)
  return attachment?.type === 'attachment' && attachment.attachment?.type === 'mod_faults'
}
