import { describe, expect, it } from 'vitest'

import { appPaneTitle } from '@/browser/webview/panes/paneKinds'

const APPS = [
  { type: 'paypal-desk:board', title: { en: 'PayPal Desk', zh: 'PayPal 工作台' } },
  { type: 'notes:board', title: 'Notes' },
]

describe('appPaneTitle', () => {
  it('names the A2UI pane after the shown session\'s app, in the UI locale', () => {
    expect(appPaneTitle(APPS, 'paypal-desk:board', 'en')).toBe('PayPal Desk')
    expect(appPaneTitle(APPS, 'paypal-desk:board', 'zh')).toBe('PayPal 工作台')
    expect(appPaneTitle(APPS, 'notes:board', 'en')).toBe('Notes')
  })

  it('a session that is no app keeps the pane\'s own name', () => {
    expect(appPaneTitle(APPS, undefined, 'en')).toBeNull()
    expect(appPaneTitle(APPS, 'code', 'en')).toBeNull()
    expect(appPaneTitle(undefined, 'notes:board', 'en')).toBeNull()
    expect(appPaneTitle([{ type: 'blank', title: '' }], 'blank', 'en')).toBeNull()
  })
})
