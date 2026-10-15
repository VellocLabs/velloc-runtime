import { afterEach, describe, expect, it } from 'vitest'
import { BotIcon, ShieldCheckIcon, CodeIcon, MessageCircleIcon } from 'lucide-react'
import type { TranslateFn } from '../browser/webview/i18n'
import {
  filterLaunchers,
  getThreadLaunchers,
  launcherTitle,
  makeImageIcon,
  type ThreadLauncher,
} from '../browser/webview/threadLaunchers'
import { __setTemplateChannelForTest } from '../prompting/templateRegistry'

// The sidebar launcher icon + title are now SOURCED from each template's
// frontmatter (`icon_lucide` / `title-i18n` / `title`) via templateRegistry's
// getTemplateIcon / getTemplateTitle. `getThreadLaunchers()` derives the list
// from the `index.md` launcher catalog (Icon = iconForType(...)).

describe('threadLaunchers — icon + title sourced from the template', () => {
  afterEach(() => __setTemplateChannelForTest(null))

  const byType = (type: string | undefined) =>
    getThreadLaunchers().find(l => l.type === type)!

  it('derives each launcher icon from the template `icon_lucide`', () => {
    expect(byType(undefined).Icon).toBe(BotIcon) // agent (boot default) → bot
    expect(byType('chat').Icon).toBe(MessageCircleIcon) // → message-circle
    expect(byType('code').Icon).toBe(CodeIcon) // → code
    expect(byType('safe_code').Icon).toBe(ShieldCheckIcon) // → shield-check
  })

  it('the safe_code launcher carries its built-in affordance (type/testId/keys)', () => {
    const safe_code = byType('safe_code')
    expect(safe_code.type).toBe('safe_code')
    expect(safe_code.testId).toBe('launcher-safe-code')
    expect(safe_code.titleKey).toBe('launcher.safeCode')
    expect(safe_code.defaultTitleKey).toBe('launcher.newSafeCode')
  })

  it('launcherTitle: resolvable title-i18n → its message; a miss → the literal title', () => {
    const chat = byType('chat')
    const resolves: TranslateFn = key =>
      key === 'launcher.chat' ? 'Chat!' : key
    const misses: TranslateFn = key => key // echoes the key (no message)
    // title-i18n resolves → its localized message (the FIRST choice).
    expect(launcherTitle(chat, resolves)).toBe('Chat!')
    // title-i18n has no message → the template's literal `title` ('Chat'),
    // NOT the bare key — matching the frontmatter contract.
    expect(launcherTitle(chat, misses)).toBe('Chat')
  })

  it('filterLaunchers: the catalog\'s launcherHidden hides safe_code on every surface', () => {
    // No location in the test realm ⇒ the stable channel ⇒ `index.md`, which
    // does not list `team` (still soaking — only `index-beta.md` does).
    const all = getThreadLaunchers()
    expect(all.some(l => l.type === 'team')).toBe(false)
    expect(all.find(l => l.type === 'safe_code')!.launcherHidden).toBe('both')
    expect(all.filter(l => l.launcherHidden).map(l => l.type)).toEqual(['safe_code'])

    // Nothing unhides a hidden type: safe_code stays off both surfaces. (The
    // old "SafeCode (Experimental)" toggle that could unhide it is gone.)
    for (const surface of ['sidebar', 'projectMenu'] as const) {
      expect(filterLaunchers(all, surface).map(l => l.type)).toEqual(
        all.filter(l => !l.launcherHidden).map(l => l.type),
      )
    }
  })

  it('the launcher list follows the channel: team is offered on beta only, nothing else moves', () => {
    const offered = (surface: 'sidebar' | 'projectMenu') =>
      filterLaunchers(getThreadLaunchers(), surface).map(l => l.type)
    __setTemplateChannelForTest('stable')
    const stable = { sidebar: offered('sidebar'), menu: offered('projectMenu') }
    __setTemplateChannelForTest('beta')
    const beta = { sidebar: offered('sidebar'), menu: offered('projectMenu') }
    for (const surface of ['sidebar', 'menu'] as const) {
      expect(stable[surface], surface).not.toContain('team')
      expect(beta[surface], surface).toContain('team')
      expect(beta[surface].filter(t => t !== 'team'), surface).toEqual(stable[surface])
    }
  })

  it('the call sites need no channel argument: the page origin and ?channel= pick the catalog', () => {
    // `Sidebar` (twice) and `ProjectSection` call `filterLaunchers(
    // getThreadLaunchers(), …)` with nothing channel-shaped, so what the realm
    // resolves IS the production gate. Every other test pins the channel; this
    // one drives the real resolution so a registry that stopped reading the
    // realm fails here instead of shipping Team to release.
    const g = globalThis as { location?: { origin?: string; search?: string } }
    const had = Object.prototype.hasOwnProperty.call(g, 'location')
    const previous = g.location
    const teamOffered = () =>
      filterLaunchers(getThreadLaunchers(), 'projectMenu').some(
        l => l.type === 'team',
      )
    try {
      g.location = { origin: 'https://app.velloc.app', search: '' }
      expect(teamOffered()).toBe(false)
      g.location = { origin: 'https://beta.velloc.app', search: '' }
      expect(teamOffered()).toBe(true)
      // An official origin is not overridable from the URL.
      g.location = { origin: 'https://app.velloc.app', search: '?channel=beta' }
      expect(teamOffered()).toBe(false)
      // A dev server is stable unless it previews beta.
      g.location = { origin: 'http://localhost:5173', search: '' }
      expect(teamOffered()).toBe(false)
      g.location = { origin: 'http://localhost:5173', search: '?channel=beta' }
      expect(teamOffered()).toBe(true)
    } finally {
      if (had) g.location = previous
      else delete g.location
    }
  })

  it('filterLaunchers is data-driven: any launcherHidden entry hides; nothing unhides it', () => {
    const Icon = BotIcon
    const fixture: ThreadLauncher[] = [
      // The agent launcher's deliberate `type: undefined` resolves to 'agent'.
      { type: undefined, Icon, testId: 'a', launcherHidden: 'both' },
      { type: 'chat', Icon, testId: 'b' },
      { type: 'researcher', Icon, testId: 'c', launcherHidden: 'both' },
      { type: 'code', Icon, testId: 'd' },
    ]
    // launcherHidden:both hides on BOTH surfaces and nothing resurrects it —
    // the visibility rule is the catalog data alone.
    expect(filterLaunchers(fixture).map(l => l.testId)).toEqual(['b', 'd'])
    expect(filterLaunchers(fixture, 'projectMenu').map(l => l.testId)).toEqual(['b', 'd'])
  })

  it('makeImageIcon: a template `icon` SVG data URI renders an <img> with that src', () => {
    // Drives the `icon` (SVG data URI) → <img> branch: getTemplateIcon returns
    // { kind: 'url' } and the launcher renders this component instead of a
    // lucide icon, with the same `className` sizing API.
    const src = 'data:image/svg+xml;base64,PHN2Zy8+'
    const Icon = makeImageIcon(src) as unknown as (props: {
      className?: string
    }) => { type: unknown; props: Record<string, unknown> }
    const el = Icon({ className: 'size-4' })
    expect(el.type).toBe('img')
    expect(el.props.src).toBe(src)
    expect(el.props.className).toBe('size-4')
  })
})
