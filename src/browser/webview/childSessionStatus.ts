/**
 * The one status a child session shows on its start card, its link chip and
 * its row, derived from the published entry alone (F-36). Pure.
 */
import type { NexusSessionActivity } from '../bridge/protocol/ui'
import type { TranslateFn } from './i18n'
import type { SessionStatusEntry } from './sessionStatusStore'
import { toolDisplayName } from '../../utils/toolLabels'
import { firstSentence } from '../../sessions/replyExcerpt'

export type ChildSessionState =
  | 'unknown'
  | 'starting'
  | 'startFailed'
  | 'archived'
  | 'waiting'
  | 'running'
  | 'finished'
  | 'failed'
  | 'stopped'
  | 'idle'

export type ChildSessionStatus = {
  state: ChildSessionState
  /** Why it did not start (`startFailed`). */
  reason?: string
  /** What it is doing (`running`). */
  activity?: NexusSessionActivity
  /** The first sentence of its last reply (a settled state). */
  lastReply?: string
}

export { firstSentence }

/**
 * Precedence: not listed, did not start, starting, archived, waiting on the
 * person, running, the last turn's ending, idle. A start that failed stays
 * failed whatever else is published.
 */
export function childSessionStatus(entry: SessionStatusEntry | undefined): ChildSessionStatus {
  if (!entry) return { state: 'unknown' }
  if (entry.startFailed) return { state: 'startFailed', reason: entry.startFailed }
  if (entry.starting) return { state: 'starting' }
  // The runtime's last reply; a preview only for a session it has no turn of.
  const lastReply = entry.lastReply ?? firstSentence(entry.previewText)
  const settled = (state: ChildSessionState): ChildSessionStatus =>
    lastReply ? { state, lastReply } : { state }
  if (entry.archived) return settled('archived')
  if (entry.needsAnswer) return { state: 'waiting' }
  if (entry.running) return entry.activity ? { state: 'running', activity: entry.activity } : { state: 'running' }
  if (entry.ending) return settled(entry.ending)
  return settled('idle')
}

/** The short state word (the chip's popover, the dot's label). */
export function childStateLabel(state: ChildSessionState, t: TranslateFn): string {
  return t(`childSession.state.${state}`)
}

/** The card's status line: the state word, with the activity or the reason when there is one. */
export function childStatusLine(status: ChildSessionStatus, t: TranslateFn): string {
  if (status.state === 'running' && status.activity) {
    const activity = status.activity
    if (activity.kind === 'tool') {
      return t('childSession.activity.tool', { tool: toolDisplayName(activity.tool) })
    }
    return t(`childSession.activity.${activity.kind}`)
  }
  if (status.state === 'startFailed' && status.reason) {
    return t('childSession.startFailedReason', { reason: status.reason })
  }
  return childStateLabel(status.state, t)
}

/** The dot's tone per state. */
export function childStateTone(state: ChildSessionState): 'busy' | 'attention' | 'ok' | 'error' | 'quiet' {
  switch (state) {
    case 'starting':
    case 'running':
      return 'busy'
    case 'waiting':
      return 'attention'
    case 'finished':
      return 'ok'
    case 'failed':
    case 'startFailed':
      return 'error'
    default:
      return 'quiet'
  }
}

/** "3 minutes ago"-style age of an activity time; an ISO date past a week. */
export function activityAge(at: number, now: number, t: TranslateFn): string {
  const sec = Math.max(0, Math.floor((now - at) / 1000))
  if (sec < 60) return t('settings.time.justNow')
  const min = Math.floor(sec / 60)
  if (min < 60) return t(min === 1 ? 'settings.time.minuteAgo' : 'settings.time.minutesAgo', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t(hr === 1 ? 'settings.time.hourAgo' : 'settings.time.hoursAgo', { n: hr })
  const day = Math.floor(hr / 24)
  if (day <= 7) return t(day === 1 ? 'settings.time.dayAgo' : 'settings.time.daysAgo', { n: day })
  return new Date(at).toISOString().slice(0, 10)
}

/** The last segment of a folder path, either separator. */
export function folderName(path: string | undefined): string | undefined {
  const trimmed = (path ?? '').replace(/[\\/]+$/, '')
  if (!trimmed) return undefined
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}
