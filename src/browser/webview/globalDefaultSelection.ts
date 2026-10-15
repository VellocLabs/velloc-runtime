/**
 * The page's mirror of the global default selection (the model + effort a new session starts on). The
 * runtime owns it and publishes `agent.changed` (F-12). Own picks show at once and hold echoes until the
 * last own write settles; the boot read is only a seed.
 */

import type { BrowserLlmSelection } from '../bridge/browserBridgeProtocol'
import type { NexusSettingsBridge } from './nexusSettingsBridge'
import { agentSetModel, agentSnapshot } from './settings/clients'

export type GlobalDefaultMirror = {
  /** This page's own pick: shown at once, written through `write`. */
  pick(selection: BrowserLlmSelection, write: () => Promise<unknown>): void
  /** A value the runtime published (`null` = no global default saved). */
  receive(selection: BrowserLlmSelection | null): void
  /** The boot read — applied only if nothing fresher has been seen. */
  seed(selection: BrowserLlmSelection | null): void
}

export function createGlobalDefaultMirror(
  apply: (selection: BrowserLlmSelection | null) => void,
): GlobalDefaultMirror {
  /** The runtime's last published value; `undefined` until one is known. */
  let published: BrowserLlmSelection | null | undefined
  let inFlight = 0
  /** Whether the runtime published anything since the latest own pick. */
  let heardSincePick = false
  let picked = false

  const settle = (ok: boolean, selection: BrowserLlmSelection, isLatest: () => boolean) => {
    inFlight -= 1
    // The write landed and no echo told us so (yet): the runtime's value is
    // now this pick — unless a later pick of ours is the one to wait for.
    if (ok && !heardSincePick && isLatest()) published = selection
    if (inFlight === 0 && published !== undefined) apply(published)
  }

  let pickSeq = 0
  return {
    pick(selection, write) {
      picked = true
      inFlight += 1
      heardSincePick = false
      const mine = ++pickSeq
      const isLatest = () => mine === pickSeq
      apply(selection)
      let pending: Promise<unknown>
      try {
        pending = write()
      } catch (error) {
        pending = Promise.reject(error)
      }
      pending.then(
        () => settle(true, selection, isLatest),
        () => settle(false, selection, isLatest),
      )
    },
    receive(selection) {
      published = selection
      heardSincePick = true
      if (inFlight === 0) apply(selection)
    },
    seed(selection) {
      if (picked || published !== undefined) return
      published = selection
      apply(selection)
    },
  }
}

/**
 * The global default carried by a settings event, if it is an
 * `agent.changed`: the selection, `null` for "none saved", or `undefined`
 * when the event is something else (or says nothing about the model).
 */
export function globalDefaultFromAgentChanged(envelope: {
  route?: unknown
  payload?: unknown
}): BrowserLlmSelection | null | undefined {
  const route = envelope.route as { capability?: unknown; action?: unknown } | undefined
  if (route?.capability !== 'agent' || route?.action !== 'changed') return undefined
  const payload = envelope.payload as { model?: unknown } | undefined
  if (!payload || !('model' in payload)) return undefined
  const model = payload.model as
    | { providerId?: unknown; modelId?: unknown; thinkingTier?: unknown }
    | null
    | undefined
  if (model === null) return null
  if (
    !model ||
    typeof model.providerId !== 'string' ||
    typeof model.modelId !== 'string'
  ) {
    return undefined
  }
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(typeof model.thinkingTier === 'string'
      ? { thinkingTier: model.thinkingTier }
      : {}),
  }
}

/**
 * Keep `mirror` on the runtime's published value: every `agent.changed`, and
 * the boot read as a seed. Subscribed BEFORE the read, so a change published
 * while the read is in flight is not lost. Returns the unsubscribe.
 */
export function followGlobalDefault(
  bridge: NexusSettingsBridge,
  mirror: GlobalDefaultMirror,
): () => void {
  let stopped = false
  const unsubscribe = bridge.subscribeEvents(envelope => {
    const model = globalDefaultFromAgentChanged(envelope)
    if (model !== undefined) mirror.receive(model)
  })
  void agentSnapshot(bridge)
    .then(result => {
      if (!stopped) mirror.seed(result.model ?? null)
    })
    .catch(() => {
      /* best-effort — new sessions fall back to the catalog default */
    })
  return () => {
    stopped = true
    unsubscribe()
  }
}

/** Write `selection` as the global default — the runtime publishes it. */
export function writeGlobalDefault(
  bridge: NexusSettingsBridge | null | undefined,
  selection: BrowserLlmSelection,
): Promise<unknown> {
  if (!bridge) return Promise.resolve()
  return agentSetModel(bridge, {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.thinkingTier ? { thinkingTier: selection.thinkingTier } : {}),
  })
}
