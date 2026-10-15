import { afterEach, describe, expect, it } from 'vitest'
import {
  __setPluginBlocklistForTests,
  isPluginBlocked,
  pluginBlockReason,
} from '../pluginHost/blocklist'

describe('plugin blocklist', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
  })

  it('blocks nothing by default', () => {
    expect(isPluginBlocked('anything@somewhere')).toBe(false)
    expect(pluginBlockReason('anything@somewhere')).toBeNull()
  })

  it('blocks an exact <name>@<marketplace> entry', () => {
    restore = __setPluginBlocklistForTests(['evil@mkt'])
    expect(isPluginBlocked('evil@mkt')).toBe(true)
    expect(pluginBlockReason('evil@mkt')).toContain('security blocklist')
    // A different marketplace for the same name is NOT blocked by an exact entry.
    expect(isPluginBlocked('evil@other')).toBe(false)
  })

  it('a bare-name entry blocks the plugin regardless of marketplace (and the git path)', () => {
    restore = __setPluginBlocklistForTests(['evil'])
    expect(isPluginBlocked('evil@mkt')).toBe(true) // marketplace install
    expect(isPluginBlocked('evil@other')).toBe(true)
    expect(isPluginBlocked('evil')).toBe(true) // /plugins git-clone path (bare name)
    expect(isPluginBlocked('good@mkt')).toBe(false)
  })

  it('restores the previous blocklist after the test seam', () => {
    const undo = __setPluginBlocklistForTests(['x@y'])
    expect(isPluginBlocked('x@y')).toBe(true)
    undo()
    expect(isPluginBlocked('x@y')).toBe(false)
  })
})
