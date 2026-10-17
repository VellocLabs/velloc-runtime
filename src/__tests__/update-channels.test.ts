import { describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_ORIGINS,
  adoptRuntimeChannel,
  channelForUrl,
  channelServesThisVersion,
  channelVersionUrl,
  currentTemplateChannel,
  currentUiChannel,
  currentUpdateChannel,
  parseUpdateChannel,
  prefValueForChannel,
  runtimeSharedWorkerName,
} from '../branding/updateChannels'

describe('channelForUrl', () => {
  it('recognises both official origins, with or without a path', () => {
    expect(channelForUrl('https://app.velloc.app/')).toBe('stable')
    expect(channelForUrl('https://app.velloc.app/v1/')).toBe('stable')
    expect(channelForUrl('https://beta.velloc.app/')).toBe('beta')
    expect(channelForUrl('https://beta.velloc.app/v1/?nexus=1')).toBe('beta')
  })

  it('returns null for anything else, so the toggle hides', () => {
    // A Debug build's default. Showing "Stable" here would be a lie.
    expect(channelForUrl('http://localhost:5173/index.html')).toBeNull()
    // A self-hosted mirror set by hand — must not be silently relabelled.
    expect(channelForUrl('https://mirror.example/nexus/')).toBeNull()
    // A lookalike host: matching must be exact, not a suffix test.
    expect(channelForUrl('https://beta.velloc.app.evil.test/')).toBeNull()
    expect(channelForUrl('')).toBeNull()
    expect(channelForUrl('not a url')).toBeNull()
  })
})

describe('currentUpdateChannel', () => {
  // The guest IS the channel's bytes, so the page's own origin names the
  // channel — no bridge call, which is what lets a synchronous render path
  // (the launcher filter) read it.
  const withOrigin = <T,>(origin: string | undefined, body: () => T): T => {
    const g = globalThis as { location?: { origin?: string } }
    const had = Object.prototype.hasOwnProperty.call(g, 'location')
    const previous = g.location
    if (origin === undefined) delete g.location
    else g.location = { origin }
    try {
      return body()
    } finally {
      if (had) g.location = previous
      else delete g.location
    }
  }

  it('reads the channel off the page origin', () => {
    expect(withOrigin('https://app.velloc.app', currentUpdateChannel)).toBe('stable')
    expect(withOrigin('https://beta.velloc.app', currentUpdateChannel)).toBe('beta')
  })

  it('is null off-channel and in a realm with no location at all', () => {
    // The dev server a Debug build defaults to, and a self-hosted mirror.
    expect(withOrigin('http://localhost:5173', currentUpdateChannel)).toBeNull()
    expect(withOrigin('https://mirror.example', currentUpdateChannel)).toBeNull()
    // The Node build step that inlines the template registry, and vitest.
    expect(withOrigin(undefined, currentUpdateChannel)).toBeNull()
  })
})

describe('currentTemplateChannel — which -beta.md files a realm uses', () => {
  // Two realms resolve this: the page (origin + its query string) and the
  // runtime SharedWorker (same origin, its own script URL, the NAME the page
  // gave it). Both are driven through the globals they really read.
  const withRealm = <T,>(
    realm: { origin?: string; search?: string; name?: string },
    body: () => T,
  ): T => {
    const g = globalThis as { location?: { origin?: string; search?: string }; name?: unknown }
    const hadLocation = Object.prototype.hasOwnProperty.call(g, 'location')
    const hadName = Object.prototype.hasOwnProperty.call(g, 'name')
    const previousLocation = g.location
    const previousName = g.name
    if (realm.origin === undefined) delete g.location
    else g.location = { origin: realm.origin, search: realm.search ?? '' }
    if (realm.name === undefined) delete g.name
    else g.name = realm.name
    try {
      return body()
    } finally {
      if (hadLocation) g.location = previousLocation
      else delete g.location
      if (hadName) g.name = previousName
      else delete g.name
    }
  }

  it('an official origin decides, and a preview override cannot move it', () => {
    expect(withRealm({ origin: 'https://beta.velloc.app' }, currentTemplateChannel)).toBe('beta')
    expect(withRealm({ origin: 'https://app.velloc.app' }, currentTemplateChannel)).toBe('stable')
    // A release user cannot reach beta templates by editing the URL…
    expect(
      withRealm({ origin: 'https://app.velloc.app', search: '?channel=beta' }, currentTemplateChannel),
    ).toBe('stable')
    // …nor by a worker name, and a beta user cannot be pulled back to stable.
    expect(
      withRealm(
        { origin: 'https://app.velloc.app', name: runtimeSharedWorkerName('beta') },
        currentTemplateChannel,
      ),
    ).toBe('stable')
    expect(
      withRealm({ origin: 'https://beta.velloc.app', search: '?channel=stable' }, currentTemplateChannel),
    ).toBe('beta')
  })

  it('off-channel is stable unless the page previews a channel with ?channel=', () => {
    expect(withRealm({ origin: 'http://localhost:5173' }, currentTemplateChannel)).toBe('stable')
    expect(
      withRealm({ origin: 'http://localhost:5173', search: '?channel=beta' }, currentTemplateChannel),
    ).toBe('beta')
    expect(
      withRealm({ origin: 'http://localhost:5173', search: '?templateType=code&channel=beta' }, currentTemplateChannel),
    ).toBe('beta')
    // An unrecognised preview previews nothing.
    expect(
      withRealm({ origin: 'http://localhost:5173', search: '?channel=nightly' }, currentTemplateChannel),
    ).toBe('stable')
    // No location at all (vitest, the Node build step) is stable too.
    expect(withRealm({}, currentTemplateChannel)).toBe('stable')
  })

  it('the worker reaches the same answer as the page through the name the page gives it', () => {
    const page = { origin: 'http://localhost:5173', search: '?channel=beta' }
    const name = withRealm(page, () => runtimeSharedWorkerName())
    expect(name).toBe('chromium-runtime-shared-worker#channel=beta')
    // The worker: same origin, its own script URL (no `channel`), that name.
    const worker = {
      origin: 'http://localhost:5173',
      search: '?worker_file&type=module',
      name,
    }
    expect(withRealm(worker, currentTemplateChannel)).toBe('beta')
    // A worker whose name carries no suffix is stable.
    expect(
      withRealm({ ...worker, name: 'chromium-runtime-shared-worker' }, currentTemplateChannel),
    ).toBe('stable')
    // Only OUR worker's name is read — a window that happens to be named like
    // the mark previews nothing.
    expect(
      withRealm({ origin: 'http://localhost:5173', name: 'other#channel=beta' }, currentTemplateChannel),
    ).toBe('stable')
  })

  it('the worker name is unchanged wherever nothing is previewed — the warm-up keeps its instance', () => {
    expect(withRealm({ origin: 'https://beta.velloc.app' }, () => runtimeSharedWorkerName())).toBe(
      'chromium-runtime-shared-worker',
    )
    // An official origin ignores a stray query param for the name too.
    expect(
      withRealm(
        { origin: 'https://app.velloc.app', search: '?channel=beta' },
        () => runtimeSharedWorkerName(),
      ),
    ).toBe('chromium-runtime-shared-worker')
    expect(withRealm({ origin: 'http://localhost:5173' }, () => runtimeSharedWorkerName())).toBe(
      'chromium-runtime-shared-worker',
    )
    expect(withRealm({}, () => runtimeSharedWorkerName())).toBe('chromium-runtime-shared-worker')
  })

  it('a remote page takes the channel its runtime reports, over its own resolution', () => {
    // A remote client is served from the desktop's relay — no official origin,
    // no preview — so on its own it is stable, whatever the desktop runs. Its
    // sessions run in the desktop's runtime, which reports ITS channel
    // (`runtime.getBuildEntry`); the remote boot adopts it.
    const relay = { origin: 'http://192.168.1.10:47615' }
    try {
      expect(withRealm(relay, currentTemplateChannel)).toBe('stable')
      expect(adoptRuntimeChannel('beta')).toBe('beta')
      expect(withRealm(relay, currentTemplateChannel)).toBe('beta')
      // The UI gates (the settings nav's beta-only entries) follow it too.
      expect(withRealm(relay, currentUiChannel)).toBe('beta')
      // It outranks everything the PAGE could say about itself: a preview
      // param, and even an official origin — the runtime's realm resolved its
      // channel by those same rules, and that is the realm the sessions run in.
      expect(withRealm({ ...relay, search: '?channel=stable' }, currentTemplateChannel)).toBe('beta')
      expect(adoptRuntimeChannel('stable')).toBe('stable')
      expect(withRealm({ origin: 'https://beta.velloc.app' }, currentTemplateChannel)).toBe('stable')
      // No channel reported (a runtime that predates the field) or a junk one
      // clears the pin: the page's own resolution stands again.
      expect(adoptRuntimeChannel(undefined)).toBeNull()
      expect(withRealm(relay, currentTemplateChannel)).toBe('stable')
      expect(withRealm({ origin: 'https://beta.velloc.app' }, currentTemplateChannel)).toBe('beta')
      expect(adoptRuntimeChannel('beta')).toBe('beta')
      expect(adoptRuntimeChannel('nightly')).toBeNull()
      expect(withRealm(relay, currentTemplateChannel)).toBe('stable')
    } finally {
      adoptRuntimeChannel(null)
    }
  })
})

describe('parseUpdateChannel', () => {
  it('accepts both channel names, and `release` as a spelling of stable', () => {
    expect(parseUpdateChannel('beta')).toBe('beta')
    expect(parseUpdateChannel('stable')).toBe('stable')
    // What the release train calls itself everywhere outside this module.
    expect(parseUpdateChannel('release')).toBe('stable')
    expect(parseUpdateChannel('  Beta ')).toBe('beta')
  })

  it('returns null for anything it does not recognise', () => {
    for (const value of ['nightly', '', 'stable-2', true, 1, null, undefined, {}]) {
      expect(parseUpdateChannel(value), String(value)).toBeNull()
    }
  })
})

describe('prefValueForChannel', () => {
  it('clears the override for stable rather than pinning a literal', () => {
    // Empty = "use the built-in default" host-side, so a binary whose default
    // later moves follows it instead of staying pinned to this bundle's guess.
    expect(prefValueForChannel('stable')).toBe('')
  })

  it('pins the beta origin', () => {
    expect(prefValueForChannel('beta')).toBe(`${CHANNEL_ORIGINS.beta}/`)
  })
})

describe('channelServesThisVersion', () => {
  it('probes the exact path the binary would request', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response)
    await channelServesThisVersion('beta', 7, fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://beta.velloc.app/v7/',
      expect.objectContaining({ method: 'HEAD' }),
    )
    expect(channelVersionUrl('beta', 7)).toBe('https://beta.velloc.app/v7/')
  })

  it('is false for a 404 — the interface-skew case', async () => {
    // The channel is up but has moved on to a newer /v<N>/. This is a
    // SUCCESSFUL load, which is exactly why it has to be probed rather than
    // discovered when the panel comes up blank.
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }) as Response)
    await expect(
      channelServesThisVersion('beta', 1, fetchImpl as unknown as typeof fetch),
    ).resolves.toBe(false)
  })

  it('fails closed when the probe throws', async () => {
    // Offline, DNS failure, CORS rejection. A false negative costs a switch
    // the user could have had; a false positive costs them the panel.
    const fetchImpl = vi.fn(async () => {
      throw new Error('network')
    })
    await expect(
      channelServesThisVersion('beta', 1, fetchImpl as unknown as typeof fetch),
    ).resolves.toBe(false)
  })
})
