/**
 * Routine subsystem entry: builds Registry, Runner, Scheduler and
 * NotificationHub, registers the singletons and starts the tick; once per
 * SharedWorker. `shutdown()` stops the tick, aborts runs and clears singletons.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { HeadlessRunner, type SpawnHeadlessSession } from './HeadlessRunner'
import { NotificationHub, type NotificationSink } from './NotificationHub'
import {
  RoutineRegistry,
  setRoutineRegistry,
} from './RoutineRegistry'
import { createRoutineFireDispatcher } from './RoutineFireDispatcher'
import { RoutineScheduler } from './RoutineScheduler'
import {
  SessionDeliveryRunner,
  type SessionDeliverySeam,
} from './SessionDeliveryRunner'
import {
  setNotificationHubSingleton,
  setRoutineRunnerSingleton,
  setRoutineSchedulerSingleton,
} from './runtimeSingletons'

export type RoutineRuntimeDeps = {
  fs: RuntimeFs
  /** Base path under which `routines/` lives. Same root as session storage. */
  storageBasePath: string
  /** Manager-supplied callback that knows how to spawn a fresh headless run. */
  spawnHeadlessSession: SpawnHeadlessSession
  /**
   * Seam for session delivery. Optional as a whole (without it such routines
   * are deferred, warned once); its halves are not independently optional.
   */
  sessionDelivery?: SessionDeliverySeam
  /** Manager-supplied sinks for notification routing. */
  notificationSinks?: NotificationSink
  /** Tick interval override. Default 30s. */
  pollEveryMs?: number
  /** Concurrency cap for HeadlessRunner. Default 3. */
  maxConcurrency?: number
  /** Optional log sink propagated into every component. */
  logEvent?: (event: string, data: Record<string, unknown>) => void
}

export type RoutineRuntimeHandle = {
  registry: RoutineRegistry
  scheduler: RoutineScheduler
  runner: HeadlessRunner
  hub: NotificationHub
  shutdown(): void
}

export async function initializeRoutineRuntime(
  deps: RoutineRuntimeDeps,
): Promise<RoutineRuntimeHandle> {
  const registry = await RoutineRegistry.load(deps.fs, deps.storageBasePath)
  setRoutineRegistry(registry)

  const hub = new NotificationHub({
    ...deps.notificationSinks,
    logEvent: deps.logEvent ?? deps.notificationSinks?.logEvent,
  })
  setNotificationHubSingleton(hub)

  const runner = new HeadlessRunner(deps.spawnHeadlessSession, {
    maxConcurrency: deps.maxConcurrency,
    logEvent: deps.logEvent,
  })
  setRoutineRunnerSingleton(runner)

  // Session delivery is optional capability, not a second scheduler: the
  // dispatcher routes each fire by its `delivery` mode.
  const sessionRunner = deps.sessionDelivery
    ? new SessionDeliveryRunner(
        deps.sessionDelivery.deliver,
        deps.sessionDelivery.canDeliver,
        { logEvent: deps.logEvent },
      )
    : null

  const dispatcher = createRoutineFireDispatcher({
    headless: runner,
    session: sessionRunner,
    logEvent: deps.logEvent,
  })

  const scheduler = new RoutineScheduler(dispatcher, {
    pollEveryMs: deps.pollEveryMs,
    logEvent: deps.logEvent,
  })
  setRoutineSchedulerSingleton(scheduler)
  scheduler.start()

  return {
    registry,
    scheduler,
    runner,
    hub,
    shutdown() {
      scheduler.stop()
      runner.abortAll()
      setRoutineRegistry(null)
      setRoutineRunnerSingleton(null)
      setRoutineSchedulerSingleton(null)
      setNotificationHubSingleton(null)
    },
  }
}
