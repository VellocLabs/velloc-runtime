/**
 * Loop timers (F-15) in the Background tasks surfaces: the schedule in words,
 * the countdown to the next fire, and the message a stop sends to the session.
 * Pure, so the card and the drawer render the same text.
 */

import { durationLabel } from '../../utils/humanize/durationLabel'
import type { NexusTaskSummaryRow } from '../bridge/protocol/ui'

import type { TranslateFn } from './i18n/translate'

/**
 * What a timer's stop button submits to its session, as the user. Model-facing
 * and always English, like a skill body.
 */
export function loopTimerCancelPrompt(timerId: string): string {
  return `Cancel the recurring loop with job ID ${timerId} by calling CronDelete, then confirm`
}

/**
 * The message a stop of task `taskId` sends, and the session it goes to, when
 * the task is a loop timer; null for every other task (stopped by the runtime).
 */
export function loopTimerStopRequest(
  rows: readonly NexusTaskSummaryRow[],
  taskId: string,
): { sessionId: string; prompt: string } | null {
  const row = rows.find((r) => r.sessionId === taskId)
  if (row?.type !== 'local_timer') return null
  return { sessionId: row.spawnerSessionId, prompt: loopTimerCancelPrompt(row.sessionId) }
}

const FIELD_NUMBER = /^\d+$/
const FIELD_STEP = /^\*\/(\d+)$/

/**
 * A 5-field cron expression in words for the shapes `/loop` writes (every N
 * minutes, every N hours, daily at a time); any other expression as written.
 */
export function loopTimerScheduleText(schedule: string, t: TranslateFn): string {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) return schedule
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return schedule

  const minuteStep = minute === '*' ? 1 : Number(FIELD_STEP.exec(minute)?.[1] ?? NaN)
  if (hour === '*' && minuteStep >= 1) {
    return minuteStep === 1
      ? t('backgroundTasks.timer.everyMinute')
      : t('backgroundTasks.timer.everyMinutes', { count: minuteStep })
  }
  if (!FIELD_NUMBER.test(minute)) return schedule
  if (hour === '*') return t('backgroundTasks.timer.everyHour')
  const hourStep = Number(FIELD_STEP.exec(hour)?.[1] ?? NaN)
  if (hourStep >= 1) {
    return hourStep === 1
      ? t('backgroundTasks.timer.everyHour')
      : t('backgroundTasks.timer.everyHours', { count: hourStep })
  }
  if (!FIELD_NUMBER.test(hour) || Number(hour) > 23 || Number(minute) > 59) return schedule
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  return t('backgroundTasks.timer.everyDayAt', { time })
}

/**
 * `Next 46s` until the fire is due, then `Due` while a held-back fire waits;
 * null when the schedule has no next slot. Seconds round up, so the label
 * never reads `0s` before the fire is due.
 */
export function loopTimerCountdown(
  nextFireAt: number | undefined,
  now: number,
  t: TranslateFn,
): string | null {
  if (nextFireAt === undefined) return null
  const left = nextFireAt - now
  if (left <= 0) return t('backgroundTasks.timer.due')
  const ms = Math.ceil(left / 1000) * 1000
  const time = durationLabel(ms, ms < 3_600_000 ? 'full' : 'largest')
  return t('backgroundTasks.timer.next', { time })
}
