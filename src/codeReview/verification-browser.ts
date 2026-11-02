import { createTranslate } from '../browser/webview/i18n/translate'
import type { ToolContract } from '../toolkit/toolContract'
import type { BehaviorExecution } from './behavior-verification'

const permitted = new Set(['BrowserNavigate', 'BrowserReadPage', 'BrowserReadElement', 'BrowserFindText', 'BrowserClick', 'BrowserType', 'BrowserSelectOption', 'BrowserHover', 'BrowserScroll', 'BrowserScrollToElement'])
const interactive = new Set(['BrowserClick', 'BrowserType', 'BrowserSelectOption', 'BrowserHover', 'BrowserScroll', 'BrowserScrollToElement'])
const common = { evaluation_previous_goal: 'Check the authorized local verification tab.', memory: 'Only the approved local application may be exercised.', next_goal: 'Observe the current verification page.' }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function envelope(value: unknown): Record<string, unknown> {
  if (object(value) && 'data' in value) value = value.data
  if (typeof value === 'string') value = JSON.parse(value)
  if (!object(value) || value.ok !== true) throw new Error('verification-browser-failed')
  return value
}

export interface VerificationBrowserApproval {
  tabId: number
  url: string
  target?: Record<string, unknown>
  warning: string
}

export function createVerificationBrowserTools(input: {
  url: string
  available: readonly ToolContract[]
  signal: AbortSignal
  authorize(name: string, args: Record<string, unknown>, approval?: VerificationBrowserApproval): Promise<boolean>
  call(name: string, args: Record<string, unknown>): Promise<unknown>
  record(execution: BehaviorExecution): Promise<void>
  sanitize(text: string): string
}): ToolContract[] {
  const origin = new URL(input.url).origin
  if (!['http:', 'https:'].includes(new URL(input.url).protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(input.url).hostname)) throw new Error('verification-local-url-required')
  let tabId: number | undefined
  let busy = false
  let activeSignal = input.signal
  const observation = (data: Record<string, unknown>): Record<string, unknown> => {
    const obs = object(data.observation) ? data.observation : undefined
    const tabs = Array.isArray(obs?.tabs) ? obs.tabs.filter(object) : []
    const id = typeof data.tab_id === 'number' ? data.tab_id : tabs.length === 1 && typeof tabs[0].tab_id === 'number' ? tabs[0].tab_id : undefined
    const tab = tabs.find(tab => tab.tab_id === id)
    const url = typeof tab?.url === 'string' ? tab.url : typeof data.url === 'string' ? data.url : undefined
    if (id === undefined || !url || new URL(url).origin !== origin || (tabId !== undefined && id !== tabId)) throw new Error('verification-tab-mismatch')
    tabId = id
    return { ...data, ...(obs ? { observation: { tabs: tab ? [tab] : [] } } : {}) }
  }
  const authorize = async (name: string, args: Record<string, unknown>, approval?: VerificationBrowserApproval) => {
    if (input.signal.aborted || activeSignal.aborted || !await input.authorize(name, structuredClone(args), approval && structuredClone(approval)) || input.signal.aborted || activeSignal.aborted) throw new Error('verification-not-authorized')
  }
  const dispatch = async (name: string, args: Record<string, unknown>) => {
    if (input.signal.aborted || activeSignal.aborted) throw new Error('verification-cancelled')
    const data = envelope(await input.call(name, args))
    if (input.signal.aborted || activeSignal.aborted) throw new Error('verification-cancelled')
    return data
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    await authorize(name, args)
    return dispatch(name, args)
  }
  const readPage = async () => observation(await call('BrowserReadPage', { ...common, include_observation: true }))
  const targetApproval = (page: Record<string, unknown>, name: string, args: Record<string, unknown>): VerificationBrowserApproval => {
    const obs = object(page.observation) ? page.observation : undefined
    const tab = Array.isArray(obs?.tabs) ? obs.tabs.find(value => object(value) && value.tab_id === tabId) : undefined
    if (!object(tab) || typeof tab.url !== 'string' || !Array.isArray(tab.elements) || page.navigation_pending === true) throw new Error('verification-target-unavailable')
    let target: Record<string, unknown> | undefined
    if (name !== 'BrowserScroll' || args.index !== undefined) {
      if (!Number.isSafeInteger(args.index)) throw new Error('verification-target-unavailable')
      const matches = tab.elements.filter(value => object(value) && value.index === args.index)
      if (matches.length !== 1) throw new Error('verification-target-unavailable')
      target = structuredClone(matches[0]) as Record<string, unknown>
      if (target.href_truncated === true) throw new Error('verification-target-destination-not-local')
      if (target.href !== undefined) {
        if (typeof target.href !== 'string') throw new Error('verification-target-destination-not-local')
        let destination: URL
        try { destination = new URL(target.href, tab.url) }
        catch { throw new Error('verification-target-destination-not-local') }
        if (destination.origin !== origin || !['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) throw new Error('verification-target-destination-not-local')
      }
    }
    return { tabId: tabId!, url: tab.url, ...(target ? { target } : {}), warning: createTranslate('en')('reviewCard.verificationWarning') }
  }
  return input.available.filter(tool => permitted.has(tool.name) && tool.offeredNow()).map(tool => ({
    ...tool, parallelSafe: () => false,
    async call(args: Record<string, unknown>, context, _permission, _row) {
      if (busy) throw new Error('verification-browser-action-in-progress')
      busy = true
      activeSignal = context.cancelSource.signal
      try {
        if (context.cancelSource.signal.aborted) throw new Error('verification-cancelled')
        const next = structuredClone(args)
        if (tool.name === 'BrowserNavigate') {
          if (typeof next.url !== 'string') throw new Error('verification-local-url-required')
          const url = new URL(next.url)
          if (url.origin !== origin || url.username || url.password) throw new Error('verification-local-url-required')
          next.new_tab = tabId === undefined
        }
        const before = tabId !== undefined ? await readPage() : undefined
        if (!before && tool.name !== 'BrowserNavigate') throw new Error('verification-navigation-required')
        const guarded = interactive.has(tool.name) || tool.name === 'BrowserReadElement'
        let data: Record<string, unknown>
        if (guarded) {
          const approval = targetApproval(before!, tool.name, next)
          await authorize(tool.name, next, approval)
          const refreshed = targetApproval(await readPage(), tool.name, next)
          if (JSON.stringify(refreshed) !== JSON.stringify(approval)) throw new Error('verification-target-changed')
          data = await dispatch(tool.name, next)
        } else data = await call(tool.name, next)
        const page = await readPage()
        const ref = crypto.randomUUID()
        const observedText = [typeof page.page_text === 'string' ? page.page_text : '', typeof data.element_text === 'string' ? data.element_text : ''].filter(Boolean).join('\n')
        const text = input.sanitize(observedText)
        if (activeSignal.aborted || input.signal.aborted) throw new Error('verification-cancelled')
        await input.record({ ref, kind: 'browser', succeeded: true, observation: text, interaction: interactive.has(tool.name) })
        return { data: { executionRef: ref, observation: input.sanitize(JSON.stringify(page)), assertionText: text } }
      } finally { busy = false }
    },
  }))
}
