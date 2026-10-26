// @vitest-environment happy-dom
/**
 * The directory page script (F-35) run in a document: cookie preference,
 * header sign-in hidden, the consent banner rejected, route reports, and the
 * page kept off the sign-in page without installing anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DIRECTORY_PAGE_SCRIPT } from '../../customize/customizePageProtocol'
import { DIRECTORY_CONSENT_COOKIE, DIRECTORY_CONSENT_REFUSED } from '../../customize/directorySite'

type Sent = Record<string, unknown>
const g = globalThis as unknown as {
  vellocHost?: { send(message: Sent): void }
  navigation?: EventTarget
  __vellocDirectoryPage?: boolean
  happyDOM: { setURL(url: string): void }
}

let sent: Sent[]
let replaced: string[]

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

  it('reports the path once per change', () => {
    run('http://127.0.0.1:4100/directory')
    vi.advanceTimersByTime(1200)
    expect(sent).toEqual([{ type: 'route', path: '/directory' }])
  })

  it('a document that lands on the sign-in page goes back to its directory returnTo, else to the start page', () => {
    run('http://127.0.0.1:4100/login?returnTo=%2Fdirectory%2Fslack')
    vi.advanceTimersByTime(1200)
    expect(replaced).toEqual(['http://127.0.0.1:4100/directory/slack'])
    expect(sent).toEqual([])

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

  it('a cancelable navigation to the sign-in page is stopped and nothing is sent', () => {
    const navigation = new EventTarget()
    g.navigation = navigation
    run('http://127.0.0.1:4100/directory/slack')
    sent.length = 0
    const navigate = (url: string, cancelable = true) => {
      const event = Object.assign(new Event('navigate', { cancelable }), { destination: { url } })
      navigation.dispatchEvent(event)
      return event
    }
    expect(navigate('http://127.0.0.1:4100/login?returnTo=%2Fdirectory%2Fslack').defaultPrevented).toBe(true)
    expect(navigate('http://127.0.0.1:4100/directory/new').defaultPrevented).toBe(false)
    expect(navigate('https://elsewhere.example/login').defaultPrevented).toBe(false)
    expect(navigate('http://127.0.0.1:4100/login', false).defaultPrevented).toBe(false)
    expect(sent).toEqual([])
    expect(replaced).toEqual([])
  })

  it('runs once per document', () => {
    run('http://127.0.0.1:4100/directory')
    new Function(DIRECTORY_PAGE_SCRIPT)()
    vi.advanceTimersByTime(400)
    expect(sent).toEqual([{ type: 'route', path: '/directory' }])
  })
})
