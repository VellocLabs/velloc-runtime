/**
 * Routine types (cron / scheduled / remote-trigger background agents).
 * One JSONL line per routine; unknown fields survive a roundtrip via the
 * index signature.
 */

export type RoutineKind = 'cron' | 'remote_trigger'

export type RoutineRunStatus = 'success' | 'error' | 'aborted'

/**
 * `notify_on`: `always` (in-app, OS push when unfocused, reminder);
 * `on_error` (failure only); `on_signal` (only on `RoutineSignal({ priority })`);
 * `silent` (persisted, never pushed).
 */
export type NotifyPolicy = 'always' | 'on_error' | 'on_signal' | 'silent'

/**
 * Signal emitted by the headless agent itself via the `RoutineSignal`
 * tool. Persisted alongside the routine's last-run record and used by
 * `NotificationHub` to gate `on_signal`/`on_error` policies.
 */
export type RoutineSignal = {
  priority: 'low' | 'normal' | 'urgent'
  message: string
  emittedAt: number
}

/**
 * Where a fire runs: `headless` (a fresh isolated session, the default) or
 * `session` (a hidden `isMeta` turn in an existing session, as `/loop` uses).
 */
export type RoutineDelivery =
  | { mode: 'headless' }
  | { mode: 'session'; sessionId: string }

export type CommonRoutineFields = {
  id: string
  /**
   * Stable user-supplied handle, unique within the registry. Used by
   * the model as a friendlier alternative to `id`. Validated as
   * `^[a-z0-9][a-z0-9-_]{0,63}$` by `RoutineRegistry.create`.
   */
  name: string
  prompt: string
  /**
   * Tool allowlist for the headless run. `undefined` means inherit
   * from the runtime preset; `[]` means deny-all (rare but valid).
   * Defense-in-depth on top of permissionMode.
   */
  permittedTools?: string[]
  /**
   * Optional model override for the headless run. When omitted, the
   * runtime's default model is used.
   */
  model?: string
  /**
   * Run-result routing. Only meaningful for `delivery.mode === 'headless'`
   * — a session-delivered fire has no `NotificationHub` dispatch, because
   * the response rendering in the user's own transcript IS the
   * notification. Left on the record for both modes so the field never
   * has to be conditionally absent.
   */
  notifyOn: NotifyPolicy
  createdAt: number
  /**
   * SessionId of the conversation that registered this routine.
   * PROVENANCE ONLY — never read as a delivery target. `delivery` owns
   * that, and conflating the two would silently turn every pre-existing
   * headless routine (which all carry this field) into a session-delivered
   * one.
   */
  createdBySessionId: string
  /**
   * How a fire is delivered; absent ⇒ `{ mode: 'headless' }`. One object so a
   * shallow update replaces mode and target together.
   */
  delivery?: RoutineDelivery
  /** Most recent run, if any. */
  lastRunAt?: number
  lastRunSessionId?: string
  lastRunStatus?: RoutineRunStatus
  lastRunSignal?: RoutineSignal
  enabled: boolean
  /**
   * One-shot flag. When true, the routine auto-disables after a
   * successful fire. Used by `ScheduleCron` to model run-once
   * semantics on top of the cron substrate.
   */
  oneShot?: boolean
}

export type CronRoutine = CommonRoutineFields & {
  kind: 'cron'
  /**
   * Cron expression in 5-field (minute, hour, day-of-month, month,
   * day-of-week) or 6-field (with seconds prefix) form. Parsed via
   * `cron-parser` at create-time; rejected if invalid.
   */
  schedule: string
  /**
   * IANA timezone name (e.g. "America/Los_Angeles") the `schedule`
   * fields are read in. Every cron routine carries one: the creator's, or
   * the host's zone at creation when none was given (`RoutineRegistry`
   * stamps it on create, and on load for older records without one,
   * persisting it with the next write). One-shots carry 'UTC'. The matcher
   * evaluates in this zone, DST included (see `cronExpression.ts`).
   */
  timezone?: string
}

export type RemoteTriggerKind = 'webhook' | 'github_event' | 'manual'

export type RemoteTriggerConfig =
  | {
      type: 'webhook'
      /** Server-assigned URL the user POSTs to. */
      url?: string
      /** Shared-secret HMAC over the request body. */
      secret?: string
    }
  | {
      type: 'github_event'
      repo: string
      event_type: string
      filter?: Record<string, unknown>
    }
  | {
      type: 'manual'
    }

export type RemoteTriggerRoutine = CommonRoutineFields & {
  kind: 'remote_trigger'
  trigger: RemoteTriggerConfig
  lastFiredAt?: number
}

export type Routine = CronRoutine | RemoteTriggerRoutine

/**
 * Persisted JSONL entry. A "tombstone" record marks a deletion so the
 * append-only log can replay losslessly. Compaction merges these out
 * on registry load.
 */
export type RoutineLogEntry =
  | { type: 'routine'; routine: Routine }
  | { type: 'tombstone'; id: string; deletedAt: number }
  | { type: 'update'; id: string; patch: Partial<Routine> }

export type RoutineRunRecord = {
  routineId: string
  sessionId: string
  startedAt: number
  finishedAt?: number
  status: RoutineRunStatus
  signal?: RoutineSignal
  /** Final assistant text or terminating error message. */
  summary?: string
}
