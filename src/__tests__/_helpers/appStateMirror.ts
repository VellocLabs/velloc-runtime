import { beforeEach } from 'vitest'

import { applyAppPatches } from '../../mods/app/appStateDiff'
import { liveAppState, onAppState } from '../../mods/app/appStateBus'

/**
 * A test's copy of the state an app's script holds, kept by applying each
 * batch the bus carries; a batch without patches is read whole. Call at the
 * top of a test file: it listens anew before each test, starting from `{}`.
 */
export function mirrorAppState(appId: string): () => unknown {
  let value: unknown = {}
  beforeEach(() => {
    value = {}
    onAppState(appId, event => {
      if (event.gone) return
      if (event.patches) {
        value = applyAppPatches(value, event.patches)
        return
      }
      void liveAppState(appId)
        ?.read()
        .then(read => {
          value = read.value
        })
    })
  })
  return () => value
}
