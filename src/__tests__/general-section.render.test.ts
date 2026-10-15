// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'

import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { CapabilityAdvert } from '../browser/runtimeProtocol'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import { I18nProvider } from '../browser/webview/i18n'
import { THEME_SWATCHES } from '../browser/webview/settings/appearanceOptions'
import { GeneralSection } from '../browser/webview/settings/sections/GeneralSection'
import {
  RuntimeCapabilitiesContext,
  type CapabilityQuery,
} from '../browser/webview/useCan'
import { queryFor } from './_helpers/capabilityQuery'
import { hasUnsavedEdits } from '../glic/unsavedEditsGate'

function makeBridge(): NexusSettingsBridge {
  return {
    request: vi.fn(async () => ({
      values: {
        fullName: 'Ada Lovelace',
        callName: 'Ada',
        workRole: 'engineering',
      },
      source: 'file',
    })),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge
}

type BridgeRequest = { route: { capability: string; action: string }; payload: unknown }

/**
 * Host transport: one `appearance.getAppearance` read seeds Appearance and the language row;
 * `appearance.setUiLocale` writes the language; `systemPrefs.get` seeds the background toggle. `writes` collects
 * the sent payloads, which the host validates.
 */
function makeTransport(locale = 'en') {
  const writes: BridgeRequest[] = []
  const routes: string[] = []
  let appearanceReads = 0
  const transport = {
    request: vi.fn(async (req: BridgeRequest) => {
      routes.push(`${req.route.capability}.${req.route.action}`)
      if (req.route.action === 'getAppearance') {
        appearanceReads += 1
        return {
          ok: true,
          result: { scheme: 'system', variant: 'tonalSpot', locale },
        }
      }
      if (req.route.capability === 'systemPrefs' && req.route.action === 'get') {
        return {
          ok: true,
          result: { backgroundModeEnabled: false, launcherEnabled: true },
        }
      }
      writes.push(req)
      return { ok: true, result: { ok: true } }
    }),
    subscribeEvents: () => () => {},
  } as unknown as BrowserBridgeTransport
  return {
    transport,
    writes,
    appearanceReads: () => appearanceReads,
    /** Every `capability.action` the page asked the host for, in order. */
    routes,
  }
}

/** `capabilities` omitted = no provider, the desktop tree every case above uses. */
function renderSection(
  transport: BrowserBridgeTransport,
  capabilities?: CapabilityQuery,
) {
  const section = createElement(
    SettingsBridgeContext.Provider,
    { value: makeBridge() },
    createElement(GeneralSection, { transport }),
  )
  return render(
    capabilities
      ? createElement(
          RuntimeCapabilitiesContext.Provider,
          { value: capabilities },
          section,
        )
      : section,
  )
}

afterEach(() => {
  cleanup()
})

describe('GeneralSection', () => {
  it('does not render the removed experimental settings group', async () => {
    renderSection(makeTransport().transport)

    await screen.findByTestId('settings-general')

    expect(screen.queryByRole('heading', { name: 'Experimental' })).toBeNull()
    expect(screen.queryByTestId('settings-safe-code-experimental')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'System' })).toBeTruthy()
  })

  it('folds Appearance in after Profile and merges Language into System', async () => {
    renderSection(makeTransport().transport)

    const page = await screen.findByTestId('settings-general')
    await screen.findByTestId('settings-appearance')

    // The separate Language section is merged INTO System: the
    // page's three headings are Profile, Appearance, System — exactly.
    const headings = Array.from(page.querySelectorAll('h2')).map(
      (h) => h.textContent,
    )
    expect(headings).toEqual(['Profile', 'Appearance', 'System'])
    // No Language heading survives, above a language control or anywhere else.
    expect(screen.queryByRole('heading', { name: 'Language' })).toBeNull()
    // Appearance really is the group after Profile, not a stray block.
    expect(
      page
        .querySelector('[data-settings-card]')!
        .contains(screen.getByTestId('profile-full-name')),
    ).toBe(true)
  })

  it('reads the appearance prefs once for both the Appearance group and the language row', async () => {
    const { transport, appearanceReads } = makeTransport('en')
    renderSection(transport)

    await screen.findByTestId('settings-appearance')
    await screen.findByTestId('settings-ui-language')

    // Two consumers, one bridge round-trip: the mount-time read is shared.
    expect(appearanceReads()).toBe(1)
  })

  it('sets the language in place instead of jumping out to chrome://settings', async () => {
    const { transport } = makeTransport('fr')
    renderSection(transport)

    await screen.findByTestId('settings-ui-language')
    // The jump-out button this replaced must be gone — leaving both would give
    // two controls for one setting, one of which cannot be embedded here. Nor
    // may a separate Language section come back: System already holds the row.
    expect(screen.queryByRole('heading', { name: 'Language' })).toBeNull()
    expect(screen.queryByTestId('settings-open-language')).toBeNull()

    // The host said `fr` while this app booted its English catalog, so a
    // restart is already pending on mount. Asserting the notice rather than
    // the trigger's rendered label proves the host's locale reached the
    // component through markup this file owns — the label is drawn by Radix
    // from a portaled item list, which is not what this test is about.
    expect(
      await screen.findByTestId('settings-language-restart-tip'),
    ).toBeTruthy()
  })

  it('writes the chosen locale and offers a restart, which is what applies it', async () => {
    const { transport, writes } = makeTransport('en')
    renderSection(transport)

    const trigger = await screen.findByTestId('settings-ui-language')
    // No restart is pending until something actually changes.
    expect(screen.queryByTestId('settings-language-restart-tip')).toBeNull()

    // Radix opens the listbox on pointerdown; the option is portaled.
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    const option = await screen.findByTestId('settings-ui-language-option-ja')
    fireEvent.click(option)

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].route.capability).toBe('appearance')
    expect(writes[0].route.action).toBe('setUiLocale')
    expect(writes[0].payload).toEqual({ locale: 'ja' })

    // The pref is only read at startup, so the row must say so and offer the
    // one action that applies it.
    const tip = await screen.findByTestId('settings-language-restart-tip')
    expect(tip.textContent).toContain('Restart required to apply this change.')
    expect(screen.getByTestId('settings-language-restart-now')).toBeTruthy()
  })

  it('restarts through the host when the notice button is clicked', async () => {
    const { transport, writes } = makeTransport('en')
    renderSection(transport)

    const trigger = await screen.findByTestId('settings-ui-language')
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByTestId('settings-ui-language-option-de'))

    const button = await screen.findByTestId('settings-language-restart-now')
    fireEvent.click(button)

    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1].route.capability).toBe('appInfo')
    expect(writes[1].route.action).toBe('relaunch')
  })

  it('keeps Appearance fully rendered on a binary without the appearance capability', async () => {
    // Per-client rework: Appearance is THIS client's localStorage now, so the
    // host capability is irrelevant to it — every control stays live. Only
    // the Language row (still a host pref) degrades.
    const transport = {
      request: vi.fn(async (req: BridgeRequest) => {
        if (
          req.route.capability === 'appearance' ||
          req.route.capability === 'systemPrefs'
        ) {
          return {
            ok: false,
            error: { code: 'NOT_IMPLEMENTED', message: 'unknown capability' },
          }
        }
        return { ok: true, result: {} }
      }),
      subscribeEvents: () => () => {},
    } as unknown as BrowserBridgeTransport

    renderSection(transport)
    await screen.findByTestId('settings-general')

    // Language row: host capability missing, so it degrades.
    await waitFor(() =>
      expect(screen.queryByTestId('settings-ui-language')).toBeNull(),
    )
    expect(
      screen.getByText(
        'This version of Velloc Code cannot change the display language from here.',
      ),
    ).toBeTruthy()

    // Appearance: every control renders — there is no host write to reject.
    expect(screen.getByTestId('appearance-mode')).toBeTruthy()
    expect(screen.getByTestId('appearance-swatches')).toBeTruthy()
    expect(screen.getByTestId('appearance-text-size')).toBeTruthy()
    expect(
      screen.queryByText(
        'This version of Velloc Code cannot change the appearance from here.',
      ),
    ).toBeNull()

    // The System group's toggle half degrades on its own capability, with its
    // own note.
    expect(
      await screen.findByText('System preferences aren’t available on this build.'),
    ).toBeTruthy()
    expect(screen.queryByTestId('system-background-mode')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'System' })).toBeTruthy()
    // The merged-away Language heading is gone even on the degraded page.
    expect(screen.queryByRole('heading', { name: 'Language' })).toBeNull()
  })
})


/**
 * The page's shape, not just its wiring. Profile used to render as bare fields
 * directly on the page while Language sat in a card right underneath, so the
 * two halves of one page looked like they came from different products. All
 * groups are cards now, and the page order is Profile → Appearance → System,
 * with the language card inside System, under the background toggle (those two
 * are its settings).
 */
describe('GeneralSection layout', () => {
  it('puts every group in a card, System last with both of its settings', async () => {
    renderSection(makeTransport().transport)

    const page = await screen.findByTestId('settings-general')
    await screen.findByTestId('settings-appearance')
    const cards = page.querySelectorAll('[data-settings-card]')
    expect(cards).toHaveLength(4)

    const [profile, appearance, system, language] = [
      cards[0]!,
      cards[1]!,
      cards[2]!,
      cards[3]!,
    ]
    expect(profile.contains(screen.getByTestId('profile-full-name'))).toBe(true)
    expect(profile.contains(screen.getByTestId('profile-call-name'))).toBe(true)
    expect(profile.contains(screen.getByTestId('profile-work-role'))).toBe(true)
    expect(appearance.contains(screen.getByTestId('appearance-mode'))).toBe(true)
    expect(appearance.contains(screen.getByTestId('appearance-swatches'))).toBe(
      true,
    )
    // The System group's two settings: the background-toggle card leads (under
    // the h2), the language card follows.
    const systemGroup = screen.getByTestId('settings-system')
    expect(systemGroup.contains(system)).toBe(true)
    expect(systemGroup.contains(language)).toBe(true)
    expect(system.contains(screen.getByTestId('system-background-mode'))).toBe(
      true,
    )
    expect(language.contains(screen.getByTestId('settings-ui-language'))).toBe(
      true,
    )
  })

  it('puts the background toggle above the language card inside System', async () => {
    renderSection(makeTransport().transport)

    const group = await screen.findByTestId('settings-system')
    await screen.findByTestId('settings-ui-language')
    await screen.findByTestId('system-background-mode')

    const title = screen.getByRole('heading', { name: 'System' })
    expect(group.contains(title)).toBe(true)
    // Title -> background toggle -> language. Language is last inside the group
    // for the same reason System is last on the page: its effect is deferred
    // to a restart, so it sits under the setting that applies immediately.
    const order = [title, screen.getByTestId('system-background-mode'), screen.getByTestId('settings-ui-language')]
    for (let i = 0; i + 1 < order.length; i += 1) {
      expect(
        order[i]!.compareDocumentPosition(order[i + 1]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
    // Exactly those two settings under the title — no third row or card.
    expect(group.querySelectorAll('[data-settings-card]')).toHaveLength(2)
  })

  /**
   * `SettingsSection` separates groups with `mt-6 first:mt-0`, which only works between siblings, so the three
   * groups must be siblings. Tailwind is not compiled here; the e2e suite reads the computed margins.
   */
  it('makes the three groups siblings so every title gets the same air above it', async () => {
    renderSection(makeTransport().transport)

    const page = await screen.findByTestId('settings-general')
    await screen.findByTestId('settings-appearance')

    const sections = Array.from(page.children).filter(
      (el) => el.tagName === 'SECTION',
    )
    expect(sections).toHaveLength(3)
    // Each group's own element, not a wrapper around it.
    expect(sections[1]!.getAttribute('data-testid')).toBe('settings-appearance')
    expect(sections[2]!.getAttribute('data-testid')).toBe('settings-system')
    for (const section of sections) {
      expect(section.className).toContain('mt-6')
      expect(section.className).toContain('first:mt-0')
    }
    // No testid'd wrapper survives around either group — that is the shape
    // that silently turned the separator off.
    for (const id of ['settings-appearance', 'settings-system']) {
      const el = screen.getByTestId(id)
      expect(el.tagName).toBe('SECTION')
      expect(el.parentElement).toBe(page)
    }
  })

  // Vertical centering is a class on a shared layout primitive, so the pin
  // lives here rather than in an e2e assertion of computed alignment: the
  // regression worth catching is a change to SettingsRow itself, and the
  // class IS the change — the only way this goes red while the compiled CSS
  // still centers is Tailwind dropping the utility, which no test here can see.
  it('centers every non-stacked SettingsRow vertically, not just the language one', async () => {
    renderSection(makeTransport().transport)

    const page = await screen.findByTestId('settings-general')
    await screen.findByTestId('settings-ui-language')
    await screen.findByTestId('system-background-mode')
    await screen.findByTestId('appearance-mode')

    // Derive the set from the markup itself — a hardcoded list rots the day a
    // fourth row appears. Selects and switches are the page's whole control
    // inventory, and each one's row is the nearest flex justify-between box.
    const rows = new Set<Element>()
    for (const control of page.querySelectorAll(
      '[data-testid="settings-ui-language"], [data-testid="system-background-mode"], [data-testid="appearance-mode"]',
    )) {
      const row = control.closest('.justify-between')
      expect(row, 'a row box above the control').not.toBeNull()
      rows.add(row!)
    }
    expect(rows.size).toBeGreaterThanOrEqual(3)
    for (const row of rows) {
      expect(row.className, 'the row centers its control vertically')
        .toContain('items-center')
      expect(row.className).not.toContain('items-start')
    }
  })

  it('holds the language card in place while the appearance read is in flight', async () => {
    // A host that never answers `getAppearance`. The card must render anyway,
    // with the select disabled on its loading placeholder — omitting it until
    // the round-trip lands makes it pop in and shove the background toggle
    // down the page, and leaves the disabled/placeholder handling unreachable.
    const transport = {
      request: vi.fn(async (req: BridgeRequest) => {
        if (req.route.action === 'getAppearance') {
          // Never settles: the pending state, held.
          return await new Promise(() => {})
        }
        if (req.route.capability === 'systemPrefs' && req.route.action === 'get') {
          return {
            ok: true,
            result: { backgroundModeEnabled: false, launcherEnabled: true },
          }
        }
        return { ok: true, result: { ok: true } }
      }),
      subscribeEvents: () => () => {},
    } as unknown as BrowserBridgeTransport

    renderSection(transport)

    const group = await screen.findByTestId('settings-system')
    const trigger = await screen.findByTestId('settings-ui-language')
    const toggle = await screen.findByTestId('system-background-mode')

    // Disabled and showing the loading placeholder — not a usable control
    // whose write would race the read that has not answered yet.
    expect(trigger.hasAttribute('disabled')).toBe(true)
    expect(trigger.textContent).toContain('Loading…')
    // And already in its final place, below the toggle inside System.
    expect(group.contains(trigger)).toBe(true)
    expect(
      toggle.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // The unavailable note belongs to a REJECTED read, not a pending one.
    expect(
      screen.queryByText(
        'This version of Velloc Code cannot change the display language from here.',
      ),
    ).toBeNull()
  })

  it('reads an unset language pref as the booted OS locale, with no restart pending', async () => {
    // A fresh profile has never written `intl.app_locale`, so the host
    // answers ''. The browser then runs in the OS language — the one this
    // app's catalog booted with (`de` here) — so nothing is pending.
    render(
      createElement(
        I18nProvider,
        { locale: 'de' as const },
        createElement(
          SettingsBridgeContext.Provider,
          { value: makeBridge() },
          createElement(GeneralSection, { transport: makeTransport('').transport }),
        ),
      ),
    )
    const trigger = (await screen.findByTestId('settings-ui-language')) as HTMLButtonElement
    // Enabled = the appearance read has landed and the row has a value.
    await waitFor(() => expect(trigger.disabled).toBe(false))
    expect(screen.queryByTestId('settings-language-restart-tip')).toBeNull()
  })

  it('keeps the restart notice inside the language card, unwarned', async () => {
    // The host says `fr` while this app booted English, so the notice is
    // pending on mount without anything having to be clicked.
    renderSection(makeTransport('fr').transport)

    const tip = await screen.findByTestId('settings-language-restart-tip')
    const language = screen
      .getByTestId('settings-ui-language')
      .closest('[data-settings-card]')!
    // At the foot of the card holding the select that caused it — not a
    // free-floating banner below the group.
    expect(language.contains(tip)).toBe(true)
    // The card is System's: the merged section owns the restart line now.
    expect(screen.getByTestId('settings-system').contains(tip)).toBe(true)
    // A pending restart is a normal consequence of the choice above, not a
    // fault: no warning fill, no warning border, no warning text.
    expect(tip.className).not.toMatch(/warning/)
  })

  it('labels the fields as settings, not as interview questions', async () => {
    renderSection(makeTransport().transport)

    await screen.findByTestId('settings-general')
    expect(screen.getByText('Preferred name')).toBeTruthy()
    expect(screen.getByText('Role')).toBeTruthy()
    // The one description that earns its place: "Preferred name" alone does
    // not say whose preference, or for what.
    expect(screen.getByText(/How you.d like to be addressed\./)).toBeTruthy()
    // The onboarding-questionnaire phrasings are gone.
    expect(screen.queryByText(/What best describes your work/)).toBeNull()
    expect(screen.queryByText(/should call you\?/)).toBeNull()
  })

  /**
   * A settings page is already the context, so a description that only
   * restates its own label is noise. Role and Display language say everything
   * they need to in the label plus the current value; the restart line under
   * the language row is kept because a deferred effect is the one thing the
   * control does NOT show.
   */
  it('leaves self-evident rows without a description', async () => {
    renderSection(makeTransport().transport)

    const page = await screen.findByTestId('settings-general')
    const text = page.textContent ?? ''
    expect(text).not.toMatch(/tailor its responses/)
    expect(text).not.toMatch(/display language\./i)
    expect(text).not.toMatch(/Choose/)
  })

  it('renders the full Appearance swatch row inside the General page', async () => {
    renderSection(makeTransport().transport)

    await screen.findByTestId('settings-appearance')
    for (const swatch of THEME_SWATCHES) {
      expect(
        screen.getByTestId(`appearance-swatch-${swatch.id}`),
      ).toBeTruthy()
    }
  })
})


/**
 * Appearance and System used to be their own left-nav pages. Three pages of a
 * handful of rows each now read as one General page, so those nav entries are
 * gone — a resurrected entry would deep-link to a page that no longer exists.
 */
describe('General page replaces the Appearance / System nav entries', () => {
  it('offers no settings-nav-appearance / settings-nav-system entry', async () => {
    const { SettingsScreen } = await import(
      '../browser/webview/settings/SettingsScreen'
    )
    const transport = makeTransport().transport
    render(
      createElement(SettingsScreen, {
        section: 'general',
        onNavigate: () => {},
        onClose: () => {},
        catalog: null,
        transport,
      }),
    )

    expect(screen.queryByTestId('settings-nav-appearance')).toBeNull()
    expect(screen.queryByTestId('settings-nav-system')).toBeNull()
    expect(screen.getByTestId('settings-nav-general')).toBeTruthy()
  })
})


/**
 * A connection holding less than `full`: every System control is a `full` host route (the language row's
 * `appearance.getAppearance` / `setUiLocale`, the restart's `appInfo.relaunch`, the background toggle's
 * `systemPrefs.*`), so none is rendered or requested; the per-client Appearance group is untouched.
 */
describe('GeneralSection under a scoped grant', () => {
  // What a manager is advertised for this page. The runtime filters the list
  // by scope, so the `full` actions are simply absent.
  const MANAGER: CapabilityAdvert[] = [
    { cap: 'profile', acts: ['snapshot', 'setField'] },
    { cap: 'appearance', acts: ['resolveTheme'] },
    { cap: 'appInfo', acts: ['getVersionInfo', 'getWebappUrl'] },
  ]
  // Every action this page can reach, as a `full` desktop connection sees it.
  const FULL: CapabilityAdvert[] = [
    { cap: 'profile', acts: ['snapshot', 'setField'] },
    { cap: 'appearance', acts: ['getAppearance', 'resolveTheme', 'setUiLocale'] },
    { cap: 'appInfo', acts: ['getVersionInfo', 'getWebappUrl', 'setWebappUrl', 'relaunch'] },
    { cap: 'systemPrefs', acts: ['get', 'setLauncher', 'setBackgroundMode'] },
  ]

  it('renders a full grant exactly as the provider-less desktop tree', async () => {
    const { transport, routes } = makeTransport()
    renderSection(transport, queryFor(FULL))

    const page = await screen.findByTestId('settings-general')
    await screen.findByTestId('settings-ui-language')
    await screen.findByTestId('system-background-mode')

    expect(
      Array.from(page.querySelectorAll('h2')).map((h) => h.textContent),
    ).toEqual(['Profile', 'Appearance', 'System'])
    expect(page.querySelectorAll('[data-settings-card]')).toHaveLength(4)
    expect(routes).toContain('appearance.getAppearance')
    expect(routes).toContain('systemPrefs.get')
  })

  it('drops the whole System group and never asks the host for it', async () => {
    // `fr` would make a restart pending on mount if the row were rendered.
    const { transport, routes } = makeTransport('fr')
    renderSection(transport, queryFor(MANAGER))

    const page = await screen.findByTestId('settings-general')
    await screen.findByTestId('settings-appearance')

    // Nothing in System is usable, so there is no group: not an empty
    // heading, and not the notes written for a binary that lacks the routes.
    expect(
      Array.from(page.querySelectorAll('h2')).map((h) => h.textContent),
    ).toEqual(['Profile', 'Appearance'])
    expect(screen.queryByTestId('settings-system')).toBeNull()
    expect(screen.queryByTestId('settings-ui-language')).toBeNull()
    expect(screen.queryByTestId('settings-language-restart-tip')).toBeNull()
    expect(screen.queryByTestId('system-background-mode')).toBeNull()
    expect(
      screen.queryByText(
        'This version of Velloc Code cannot change the display language from here.',
      ),
    ).toBeNull()
    expect(
      screen.queryByText('System preferences aren’t available on this build.'),
    ).toBeNull()

    // Not issued: each could only have come back `forbidden_scope`.
    expect(routes).not.toContain('appearance.getAppearance')
    expect(routes).not.toContain('systemPrefs.get')

    // Appearance is this client's own view — every control stays.
    expect(screen.getByTestId('appearance-mode')).toBeTruthy()
    expect(screen.getByTestId('appearance-swatches')).toBeTruthy()
    expect(screen.getByTestId('appearance-text-size')).toBeTruthy()
  })

  it('keeps the half of System the connection can use', async () => {
    // A grant with the host toggle but not the language pref: each half gates
    // on its own actions, so the group keeps its heading and its one card.
    const { transport, routes } = makeTransport()
    renderSection(
      transport,
      queryFor([
        ...MANAGER,
        { cap: 'systemPrefs', acts: ['get', 'setLauncher', 'setBackgroundMode'] },
      ]),
    )

    const group = await screen.findByTestId('settings-system')
    await screen.findByTestId('system-background-mode')
    expect(screen.queryByTestId('settings-ui-language')).toBeNull()
    expect(group.querySelectorAll('[data-settings-card]')).toHaveLength(1)
    expect(routes).toContain('systemPrefs.get')
    expect(routes).not.toContain('appearance.getAppearance')
  })

  it('needs every systemPrefs action the toggle uses, not just the read', async () => {
    // The toggle writes BOTH setBackgroundMode and setLauncher. A read alone
    // would render a switch whose every flip is refused.
    const { transport, routes } = makeTransport()
    renderSection(
      transport,
      queryFor([...MANAGER, { cap: 'systemPrefs', acts: ['get'] }]),
    )

    await screen.findByTestId('settings-appearance')
    expect(screen.queryByTestId('system-background-mode')).toBeNull()
    expect(screen.queryByTestId('settings-system')).toBeNull()
    expect(routes).not.toContain('systemPrefs.get')
  })

  it('keeps the restart notice but not its button without appInfo.relaunch', async () => {
    const { transport } = makeTransport('fr')
    renderSection(
      transport,
      queryFor([
        { cap: 'profile', acts: ['snapshot', 'setField'] },
        { cap: 'appearance', acts: ['getAppearance', 'resolveTheme', 'setUiLocale'] },
      ]),
    )

    // Host `fr`, English catalog: the restart is pending on mount.
    const tip = await screen.findByTestId('settings-language-restart-tip')
    expect(tip.textContent).toContain('Restart required to apply this change.')
    expect(screen.queryByTestId('settings-language-restart-now')).toBeNull()
  })

  it('holds the updater reload gate while a profile field has uncommitted typing', async () => {
    renderSection(makeTransport().transport)
    const field = (await screen.findByTestId('profile-full-name')) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('Ada Lovelace'))
    expect(hasUnsavedEdits()).toBe(false)
    fireEvent.change(field, { target: { value: 'Ada King' } })
    expect(hasUnsavedEdits()).toBe(true)
    fireEvent.change(field, { target: { value: 'Ada Lovelace' } })
    expect(hasUnsavedEdits()).toBe(false)
  })
})
