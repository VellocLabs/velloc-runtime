/**
 * Routine subsystem singletons, set by the manager at boot and read by tools;
 * tests reset each setter with `null`.
 */

import type { HeadlessRunner } from './HeadlessRunner'
import type { NotificationHub } from './NotificationHub'
import type { RoutineScheduler } from './RoutineScheduler'

let runnerSingleton: HeadlessRunner | null = null
let schedulerSingleton: RoutineScheduler | null = null
let hubSingleton: NotificationHub | null = null

export function setRoutineRunnerSingleton(
  runner: HeadlessRunner | null,
): void {
  runnerSingleton = runner
}

export function getRoutineRunnerSingleton(): HeadlessRunner | null {
  return runnerSingleton
}

export function setRoutineSchedulerSingleton(
  scheduler: RoutineScheduler | null,
): void {
  schedulerSingleton = scheduler
}

export function getRoutineSchedulerSingleton(): RoutineScheduler | null {
  return schedulerSingleton
}

export function setNotificationHubSingleton(hub: NotificationHub | null): void {
  hubSingleton = hub
}

export function getNotificationHubSingleton(): NotificationHub | null {
  return hubSingleton
}
