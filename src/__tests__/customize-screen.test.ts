import { describe, expect, it } from 'vitest'

import { directoryUrl } from '../browser/webview/customize/customizeRoutes'
import { DIRECTORY_SITE_ORIGIN } from '../customize/directorySite'

describe('Customize page', () => {
  it('is the directory start page on the live site', () => {
    expect(directoryUrl()).toBe(`${DIRECTORY_SITE_ORIGIN}/directory`)
  })

  it('an e2e run may point the page at another origin, never at a path', () => {
    const g = globalThis as { __NEXUS_E2E_CUSTOMIZE_ORIGIN__?: unknown }
    try {
      g.__NEXUS_E2E_CUSTOMIZE_ORIGIN__ = 'http://127.0.0.1:4100'
      expect(directoryUrl()).toBe('http://127.0.0.1:4100/directory')
      g.__NEXUS_E2E_CUSTOMIZE_ORIGIN__ = 'http://127.0.0.1:4100/elsewhere'
      expect(directoryUrl()).toBe(`${DIRECTORY_SITE_ORIGIN}/directory`)
      g.__NEXUS_E2E_CUSTOMIZE_ORIGIN__ = 'javascript:alert(1)'
      expect(directoryUrl()).toBe(`${DIRECTORY_SITE_ORIGIN}/directory`)
    } finally {
      delete g.__NEXUS_E2E_CUSTOMIZE_ORIGIN__
    }
  })
})
