// @vitest-environment happy-dom
/**
 * The directory page script (F-35) run in a document: cookie preference,
 * header sign-in hidden, the consent banner rejected, route reports with the
 * page's history, the page kept off the sign-in page (asking to add instead)
 * and on its own site (asking to open other sites elsewhere).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DIRECTORY_PAGE_SCRIPT } from '../../customize/customizePageProtocol'
import { DIRECTORY_CONSENT_COOKIE, DIRECTORY_CONSENT_REFUSED } from '../../customize/directorySite'

type Sent = Record<string, unknown>
const g = globalThis as unknown as {
  vellocHost?: { send(message: Sent): void }
  navigation?: EventTarget & { canGoBack?: boolean }
  __vellocDirectoryPage?: boolean
  happyDOM: { setURL(url: string): void }
}

let sent: Sent[]
let replaced: string[]

const route = (href: string, canGoBack = false) => ({
  type: 'route',
  path: new URL(href).pathname,
  href,
  canGoBack,
})

function fakeNavigation(canGoBack = false) {
  const navigation = Object.assign(new EventTarget(), { canGoBack })
  g.navigation = navigation
  const navigate = (url: string, cancelable = true) => {
    const event = Object.assign(new Event('navigate', { cancelable }), { destination: { url } })
    navigation.dispatchEvent(event)
    return event
  }
  return { navigation, navigate }
}

function clickLink(href: string, init: MouseEventInit & { target?: string } = {}) {
  const link = document.createElement('a')
  link.href = href
  if (init.target) link.target = init.target
  link.innerHTML = '<span>go</span>'
  document.body.appendChild(link)
  const event = new MouseEvent(init.button === 1 ? 'auxclick' : 'click', { bubbles: true, cancelable: true, ...init })
  link.querySelector('span')!.dispatchEvent(event)
  return event
}

function run(url: string) {
  g.happyDOM.setURL(url)
  new Function(DIRECTORY_PAGE_SCRIPT)()
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  replaced = []
  g.vellocHost = { send: message => sent.push(message) }
  vi.spyOn(window.location, 'replace').mockImplementation(url => {
    replaced.push(String(url))
  })
  for (const cookie of document.cookie.split(/;\s*/)) {
    const name = cookie.split('=')[0]
    if (name) document.cookie = `${name}=; max-age=0; path=/`
  }
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  sessionStorage.clear()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete g.__vellocDirectoryPage
  delete g.vellocHost
  delete g.navigation
})

describe('directory page script', () => {
  it('turns optional cookies off before the page reads them, and keeps an existing choice', () => {
    run('http://127.0.0.1:4100/directory')
    expect(decodeURIComponent(document.cookie)).toContain(`${DIRECTORY_CONSENT_COOKIE}=${DIRECTORY_CONSENT_REFUSED}`)

    delete g.__vellocDirectoryPage
    document.cookie = `${DIRECTORY_CONSENT_COOKIE}=${encodeURIComponent('{"analytics":true,"marketing":true}')}; path=/`
    run('http://127.0.0.1:4100/directory')
    expect(decodeURIComponent(document.cookie)).toContain('"analytics":true')
  })

  it('hides the header sign-in link and presses the banner reject button when it shows', () => {
    run('http://127.0.0.1:4100/directory')
    const style = document.getElementById('velloc-directory-style')
    expect(style?.textContent).toContain('.dframe-header a[href^="/login"]')
    const bar = document.createElement('div')
    bar.className = 'dframe-header'
    bar.innerHTML = '<a href="/login?returnTo=%2Fdirectory">Sign in</a>'
    const add = document.createElement('main')
    add.innerHTML = '<a href="/login?returnTo=%2Fdirectory%2Fslack">Sign in to add</a>'
    document.body.append(bar, add)
    expect(getComputedStyle(bar.querySelector('a')!).display).toBe('none')
    expect(getComputedStyle(add.querySelector('a')!).display).not.toBe('none')

    const reject = document.createElement('button')
    reject.dataset.testid = 'consent-reject'
    const clicked = vi.fn()
    reject.addEventListener('click', clicked)
    document.body.appendChild(reject)
    vi.advanceTimersByTime(400)
    expect(clicked).toHaveBeenCalled()
  })

  it('reports the path once per change, with the address and whether the page can go back', () => {
    const { navigation } = fakeNavigation(false)
    run('http://127.0.0.1:4100/directory')
    vi.advanceTimersByTime(1200)
    expect(sent).toEqual([route('http://127.0.0.1:4100/directory')])

    navigation.canGoBack = true
    vi.advanceTimersByTime(400)
    expect(sent).toEqual([route('http://127.0.0.1:4100/directory'), route('http://127.0.0.1:4100/directory', true)])
  })

  it('a document that lands on the sign-in page goes back to its directory returnTo, else to the start page', () => {
    run('http://127.0.0.1:4100/login?returnTo=%2Fdirectory%2Fslack')
    vi.advanceTimersByTime(1200)
    expect(replaced).toEqual(['http://127.0.0.1:4100/directory/slack'])
    expect(sent).toEqual([{ type: 'add', returnTo: '/directory/slack' }])

    for (const returnTo of ['%2F%2Fevil.example%2Fdirectory', '%2Fsettings', 'https%3A%2F%2Fevil.example']) {
      delete g.__vellocDirectoryPage
      replaced.length = 0
      run(`http://127.0.0.1:4100/login?returnTo=${returnTo}`)
      expect(replaced).toEqual(['http://127.0.0.1:4100/directory'])
    }
  })

  it('a document that lands on the sign-in page goes back to the directory page the tab last showed', () => {
    run('http://127.0.0.1:4100/directory/plugins/slack?tab=connectors')
    vi.advanceTimersByTime(400)
    delete g.__vellocDirectoryPage
    run('http://127.0.0.1:4100/login')
    expect(replaced).toEqual(['http://127.0.0.1:4100/directory/plugins/slack?tab=connectors'])

    delete g.__vellocDirectoryPage
    replaced.length = 0
    run('http://127.0.0.1:4100/login?returnTo=%2Fdirectory')
    expect(replaced).toEqual(['http://127.0.0.1:4100/directory/plugins/slack?tab=connectors'])
  })

  it('a page outside the directory is not kept as the page to go back to', () => {
    run('http://127.0.0.1:4100/directory/slack')
    delete g.__vellocDirectoryPage
    run('http://127.0.0.1:4100/settings')
    delete g.__vellocDirectoryPage
    run('http://127.0.0.1:4100/login')
    expect(replaced).toEqual(['http://127.0.0.1:4100/directory/slack'])
  })

  it('a cancelable navigation to the sign-in page is stopped and asks to add instead', () => {
    const { navigate } = fakeNavigation()
    run('http://127.0.0.1:4100/directory/slack')
    sent.length = 0
    expect(navigate('http://127.0.0.1:4100/login?returnTo=%2Fdirectory%2Fslack').defaultPrevented).toBe(true)
    expect(navigate('http://127.0.0.1:4100/directory/new').defaultPrevented).toBe(false)
    expect(navigate('http://127.0.0.1:4100/login', false).defaultPrevented).toBe(false)
    expect(sent).toEqual([{ type: 'add', returnTo: '/directory/slack' }])
    expect(replaced).toEqual([])
  })

  it('a cancelable navigation to another site is stopped and asked to open elsewhere, once per address', () => {
    const { navigate } = fakeNavigation()
    run('http://127.0.0.1:4100/directory/slack')
    sent.length = 0
    expect(navigate('https://elsewhere.example/docs').defaultPrevented).toBe(true)
    expect(navigate('https://elsewhere.example/docs').defaultPrevented).toBe(true)
    expect(navigate('http://localhost:4100/directory').defaultPrevented).toBe(true)
    expect(navigate('https://elsewhere.example/later', false).defaultPrevented).toBe(false)
    expect(navigate('mailto:someone@example.com').defaultPrevented).toBe(false)
    expect(sent).toEqual([
      { type: 'external', url: 'https://elsewhere.example/docs' },
      { type: 'external', url: 'http://localhost:4100/directory' },
    ])
    vi.advanceTimersByTime(1000)
    navigate('https://elsewhere.example/docs')
    expect(sent.filter(m => m.type === 'external')).toHaveLength(3)
  })

  it('a sign-in link is stopped before the page handles the click, so its router cannot render the sign-in view', () => {
    run('http://127.0.0.1:4100/directory')
    const routed: string[] = []
    const router = (event: Event) => routed.push((event.target as Element).closest('a')!.getAttribute('href')!)
    document.addEventListener('click', router, true)
    document.addEventListener('click', router)
    try {
      expect(clickLink('/login?returnTo=%2Fdirectory').defaultPrevented).toBe(true)
      expect(clickLink('https://elsewhere.example/first').defaultPrevented).toBe(true)
      clickLink('/directory/new')
      expect(routed).toEqual(['/directory/new', '/directory/new'])
    } finally {
      document.removeEventListener('click', router, true)
      document.removeEventListener('click', router)
    }
  })

  it('a stopped sign-in navigation whose view was rendered anyway loads the page again', () => {
    const { navigate } = fakeNavigation()
    run('http://127.0.0.1:4100/directory')
    document.title = 'Directory'
    navigate('http://127.0.0.1:4100/login?returnTo=%2Fdirectory')
    document.title = 'Log in'
    vi.advanceTimersByTime(300)
    expect(replaced).toEqual(['http://127.0.0.1:4100/directory'])

    replaced.length = 0
    navigate('http://127.0.0.1:4100/login?returnTo=%2Fdirectory')
    vi.advanceTimersByTime(300)
    expect(replaced).toEqual([])
  })

  it('a click on a link to another site, in any target, opens it elsewhere; a sign-in link asks to add', () => {
    run('http://127.0.0.1:4100/directory/slack')
    sent.length = 0
    expect(clickLink('https://elsewhere.example/a', { target: '_blank' }).defaultPrevented).toBe(true)
    expect(clickLink('https://elsewhere.example/b', { button: 1 }).defaultPrevented).toBe(true)
    expect(clickLink('/login?returnTo=%2Fdirectory%2Fslack', { target: '_blank' }).defaultPrevented).toBe(true)
    expect(clickLink('/directory/new').defaultPrevented).toBe(false)
    expect(sent).toEqual([
      { type: 'external', url: 'https://elsewhere.example/a' },
      { type: 'external', url: 'https://elsewhere.example/b' },
      { type: 'add', returnTo: '/directory/slack' },
    ])
  })

  it('runs once per document', () => {
    run('http://127.0.0.1:4100/directory')
    new Function(DIRECTORY_PAGE_SCRIPT)()
    vi.advanceTimersByTime(400)
    expect(sent).toEqual([route('http://127.0.0.1:4100/directory', expect.any(Boolean) as unknown as boolean)])
  })
})
