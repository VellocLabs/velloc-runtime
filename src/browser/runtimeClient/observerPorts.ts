/**
 * Runtime ports for code the page does not trust (F-42): the page never holds
 * the SharedWorker's port itself, only this opener, and every port it opens
 * is capped by the SharedWorker to `observe` on the named topics before any
 * other code holds it.
 */

import { attachRuntimePort } from './sharedWorkerConnection'

type Opener = (topics: readonly string[]) => MessagePort

let opener: Opener | null = null

/** Boot only: binds the opener to this page's SharedWorker port. */
export function provideObserverPorts(sharedWorkerPort: MessagePort, homeDir: string): void {
  opener = topics => attachRuntimePort(sharedWorkerPort, { homeDir, delegate: { scope: 'observe', topics: [...topics] } })
}

/**
 * A fresh port capped to `observe` on `topics`, for a sandboxed frame to speak
 * the runtime protocol over; null before boot bound one. The caller owns it
 * and closes it when the frame goes.
 */
export function openObserverPort(topics: readonly string[]): MessagePort | null {
  return opener ? opener(topics) : null
}

/** Tests only. */
export function resetObserverPortsForTests(): void {
  opener = null
}
