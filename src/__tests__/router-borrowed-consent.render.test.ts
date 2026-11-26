// @vitest-environment happy-dom
/**
 * The consent dialog of a router that borrows providers (F-27 RP-21): the
 * line that names them, and its absence for a router that borrows nothing.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createTranslate } from '../browser/webview/i18n'
import { ProviderConsentDialog } from '../browser/webview/settings/sections/ProviderModUpdates'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { pluginGrantOf, type Grant } from '../pluginHost/providerGrant'
import type { ProviderModUpdateStatus } from '../pluginHost/providerModUpdates'

afterEach(cleanup)

const t = createTranslate('en')

function grantOf(borrows?: string[]): Grant {
  const { manifest, errors } = checkPluginDescriptor({
    name: 'hub',
    version: '1.0.0',
    providers: {
      router: {
        providerApi: 1,
        kind: 'router',
        displayName: 'Hub',
        credentials: { methods: ['anonymous'] },
        routesTo: '*',
        ...(borrows ? { borrows } : {}),
        module: './providers/router.js',
      },
    },
  })
  expect(errors).toEqual([])
  return pluginGrantOf(manifest)
}

function open(grant: Grant) {
  const status = { pluginId: 'hub@shop', state: 'up-to-date', grant, consented: false, activeVersion: '1.0.0' } as ProviderModUpdateStatus
  render(
    createElement(ProviderConsentDialog, {
      target: { name: 'hub', status },
      busy: false,
      error: null,
      onEnable: () => {},
      onCancel: () => {},
      t,
    }),
  )
}

describe('the consent dialog of a router', () => {
  it('names the services it may add keys of its own for, after its routes line', () => {
    open(grantOf(['mod.vendor-a.main', 'google']))
    const routes = screen.getByTestId('consent-routes-router')
    const borrows = screen.getByTestId('consent-borrows-router')
    expect(borrows.textContent).toBe(
      'Can add keys and sign-ins of its own for these services, used only by it and not shown in your Models settings: google, mod.vendor-a.main',
    )
    expect(routes.compareDocumentPosition(borrows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('has no such line for a router that borrows nothing', () => {
    open(grantOf())
    expect(screen.getByTestId('consent-routes-router')).toBeTruthy()
    expect(screen.queryByTestId('consent-borrows-router')).toBeNull()
  })
})
