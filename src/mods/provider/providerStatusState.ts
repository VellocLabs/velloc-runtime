/**
 * Contract: a provider's status view on the runtime protocol (F-27). The
 * runtime reads the values from the plugin's `$.store`, shapes and clamps
 * them, and publishes them on one global topic. A client never reads the
 * store; it asks for a re-read with `providerStatus.refresh` and runs a
 * declared job with `providerStatus.runJob` (both scope `control`).
 * Pure types and constants: safe for the runtime and the page alike.
 */
import type { LocalizedText } from '../../config/localizedText'
import type { ProviderStatusColumn } from './providerStatusManifest'

/** Snapshot + `state` deltas, each the whole `ProviderStatusState`. Readable
 *  at `observe`: it carries what the settings page shows, never a credential. */
export const PROVIDER_STATUS_TOPIC = 'providers/status'

export const PROVIDER_STATUS_CAPABILITY = 'providerStatus'

/** A text value is cut to this many characters. */
export const PROVIDER_STATUS_TEXT_MAX = 500
/** The characters of text one provider's entry may carry in all; list rows
 *  past it are left out. */
export const PROVIDER_STATUS_ENTRY_TEXT_BUDGET = 64 * 1024

export type ProviderStatusTone = 'neutral' | 'ok' | 'warn' | 'error'
export const PROVIDER_STATUS_TONES: readonly ProviderStatusTone[] = ['neutral', 'ok', 'warn', 'error']

/** One shaped value. A value the store does not hold, or holds in a type the
 *  format cannot read, is absent, never guessed. */
export type ProviderStatusCell =
  | { format: 'text'; text: string }
  | { format: 'count'; value: number }
  /** Epoch milliseconds. */
  | { format: 'time'; at: number }
  | { format: 'duration'; ms: number }
  /** 0 to 100. */
  | { format: 'percent'; value: number }
  | { format: 'badge'; text: string; tone: ProviderStatusTone }

export type ProviderStatusListColumn = ProviderStatusColumn

export type ProviderStatusRow =
  | { key: string; label: LocalizedText; kind: 'value'; cell?: ProviderStatusCell }
  | {
      key: string
      label: LocalizedText
      kind: 'list'
      columns: ProviderStatusListColumn[]
      /** One array per row, a cell (or null) per column. */
      items: Array<Array<ProviderStatusCell | null>>
      /** Rows the store holds, before the cut to the field's limit. */
      total: number
    }

export type ProviderStatusActionView = { job: string; label: LocalizedText }

export type ProviderStatusEntry = {
  rows: ProviderStatusRow[]
  actions: ProviderStatusActionView[]
  /** Epoch ms of the read this entry was shaped from. */
  readAt: number
  /** True when the store holds no object under the view's key yet. */
  empty?: boolean
  /** The read failed; `rows` then carry no values. */
  error?: true
}

export type ProviderStatusState = Record<string, ProviderStatusEntry>

export type ProviderStatusRefreshPayload = { providerId: string }

export type ProviderStatusRunJobPayload = { providerId: string; job: string }

/** What became of a request to run a job now. */
export type ProviderJobRunOutcome = 'started' | 'unavailable' | 'busy' | 'cooldown'

export type ProviderStatusRunJobResult = { outcome: ProviderJobRunOutcome }
