/**
 * The official runtime channels the About page can switch between. The guest
 * URL pref may point anywhere; the switch is offered only for these origins and
 * hidden otherwise.
 */

export type UpdateChannel = 'stable' | 'beta'

export const CHANNEL_ORIGINS: Record<UpdateChannel, string> = {
  stable: 'https://app.velloc.app',
  beta: 'https://beta.velloc.app',
}

/**
 * Display order for the channel picker — most conservative first. Kept here
 * rather than in the component so a third channel is one edit, not two, and so
 * `Object.keys(CHANNEL_ORIGINS)` (insertion-ordered, easy to reshuffle by
 * accident) never decides what the user sees.
 */
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ['stable', 'beta']

/** The channel labelled "Recommended" in the picker. */
export const RECOMMENDED_CHANNEL: UpdateChannel = 'stable'

/**
 * What to write to `nexus.webapp_url` for a channel. Stable writes `''` (the
 * built-in default), which assumes the built-in default is the stable origin.
 */
export function prefValueForChannel(channel: UpdateChannel): string {
  return channel === 'stable' ? '' : `${CHANNEL_ORIGINS.beta}/`
}

/**
 * Which channel a resolved guest URL belongs to, or `null` when it is not an
 * official origin — a self-hosted mirror, or the localhost dev server a Debug
 * build defaults to. `null` is what hides the toggle.
 */
export function channelForUrl(url: string): UpdateChannel | null {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return null
  }
  for (const channel of Object.keys(CHANNEL_ORIGINS) as UpdateChannel[]) {
    if (new URL(CHANNEL_ORIGINS[channel]).host === host) return channel
  }
  return null
}

/**
 * The channel the running bundle was served from (its own origin); `null` for
 * any non-official origin or a realm without `location`.
 */
export function currentUpdateChannel(): UpdateChannel | null {
  const origin = (globalThis as { location?: { origin?: string } }).location
    ?.origin
  return origin ? channelForUrl(origin) : null
}

/** The query parameter that previews a channel's templates off-channel. */
export const TEMPLATE_CHANNEL_PARAM = 'channel'

/** The runtime SharedWorker's base name (`createBrowserRuntimeSharedWorker`). */
export const RUNTIME_SHARED_WORKER_NAME = 'chromium-runtime-shared-worker'

/** Separates the base name from a previewed channel: `<base>#channel=beta`. */
const WORKER_NAME_CHANNEL_MARK = `#${TEMPLATE_CHANNEL_PARAM}=`

// The channel of the runtime this page DRIVES but does not host
// (`adoptRuntimeChannel`) — a remote client's. `null` = this realm hosts its
// own runtime, or is that runtime (the desktop page, the SharedWorker).
let adoptedRuntimeChannel: UpdateChannel | null = null

/**
 * Adopt the channel the connected runtime reports (remote boot only: a remote
 * page's own origin is never official). `null`, and the pin cleared, for a
 * value `parseUpdateChannel` rejects.
 */
export function adoptRuntimeChannel(reported: unknown): UpdateChannel | null {
  adoptedRuntimeChannel = parseUpdateChannel(reported)
  return adoptedRuntimeChannel
}

/**
 * The channel whose template files this realm uses; never `null`. Order: an
 * adopted runtime channel; an official origin (nothing overrides it); off
 * channel, a `?channel=beta` page override or the SharedWorker `name` suffix;
 * else `stable`. Page and worker must agree, so the page forwards the override
 * in the worker's name.
 */
export function currentTemplateChannel(): UpdateChannel {
  return (
    adoptedRuntimeChannel ??
    currentUpdateChannel() ??
    templateChannelOverride() ??
    'stable'
  )
}

// Test-only pin for the UI channel (`__setUiChannelForTest`); `null` reads
// the realm (`currentTemplateChannel`). Same shape as templateRegistry's
// `channelForTest` — a UI surface that gates on the channel (the settings
// nav's beta-only entries) cannot use that module's pin: `templateRegistry`
// imports the build-time virtual template registry, which does not resolve
// under vitest, so a UI test cannot reach the pin through it.
let uiChannelForTest: UpdateChannel | null = null

/**
 * The channel a UI FEATURE gate reads. Identical resolution to
 * `currentTemplateChannel` — a beta-only nav entry and a beta-only template
 * must agree — but pinned independently so a UI unit test can set it without
 * loading the template registry.
 */
export function currentUiChannel(): UpdateChannel {
  return uiChannelForTest ?? currentTemplateChannel()
}

/** Test-only: pin the channel the UI gates on (`null` = read the realm). */
export function __setUiChannelForTest(channel: UpdateChannel | null): void {
  uiChannelForTest = channel
}

/**
 * The off-channel preview override in THIS realm, or `null` when none is set.
 * Reads the page's `?channel=` first, then the worker-name suffix. Only
 * consulted off-channel (`currentTemplateChannel`).
 */
export function templateChannelOverride(): UpdateChannel | null {
  const g = globalThis as { location?: { search?: string }; name?: unknown }
  try {
    const fromQuery = new URLSearchParams(g.location?.search ?? '').get(
      TEMPLATE_CHANNEL_PARAM,
    )
    if (fromQuery !== null) return parseUpdateChannel(fromQuery)
  } catch {
    // No usable location — fall through to the worker name.
  }
  if (typeof g.name === 'string') {
    const at = g.name.indexOf(WORKER_NAME_CHANNEL_MARK)
    if (at >= 0 && g.name.slice(0, at) === RUNTIME_SHARED_WORKER_NAME) {
      return parseUpdateChannel(g.name.slice(at + WORKER_NAME_CHANNEL_MARK.length))
    }
  }
  return null
}

/**
 * The runtime SharedWorker's name for a page whose off-channel preview override
 * is `override`: the base name when there is none (so the warm-up script and the
 * boot path keep meeting the same instance, and an official origin never gets a
 * suffix), `<base>#channel=<override>` otherwise.
 */
export function runtimeSharedWorkerName(
  override: UpdateChannel | null = currentUpdateChannel()
    ? null
    : templateChannelOverride(),
): string {
  return override
    ? `${RUNTIME_SHARED_WORKER_NAME}${WORKER_NAME_CHANNEL_MARK}${override}`
    : RUNTIME_SHARED_WORKER_NAME
}

/**
 * A channel name → the channel it names, or `null` when it names none.
 *
 * `release` is accepted as a spelling of `stable`: the release train calls
 * itself that everywhere outside this module. Anything else — a typo included —
 * is `null`; a `?channel=nightly` preview override therefore previews nothing
 * and the realm stays on stable.
 */
export function parseUpdateChannel(value: unknown): UpdateChannel | null {
  if (typeof value !== 'string') return null
  const name = value.trim().toLowerCase()
  if (name === 'beta') return 'beta'
  if (name === 'stable' || name === 'release') return 'stable'
  return null
}

/** The path a binary on `version` actually requests from a channel. */
export function channelVersionUrl(
  channel: UpdateChannel, version: number): string {
  return `${CHANNEL_ORIGINS[channel]}/v${version}/`
}

/**
 * Whether `channel` serves this bundle's interface version, probed before
 * switching (a missing `/v<N>/` would brick the panel). Fails closed on any
 * network, CORS or non-2xx error; relies on the origins sending
 * `Access-Control-Allow-Origin`.
 */
export async function channelServesThisVersion(
  channel: UpdateChannel,
  version: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(channelVersionUrl(channel, version), {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'follow',
    })
    return res.ok
  } catch {
    return false
  }
}
