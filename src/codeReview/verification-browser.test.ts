import { describe, expect, it, vi } from 'vitest'
import { declareTool } from '../toolkit/toolContract'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { Message } from '../runtime/RuntimeTypes'
import type { BehaviorExecution } from './behavior-verification'
import { createVerificationBrowserTools, type VerificationBrowserApproval } from './verification-browser'

function fixture() {
  const available = ['BrowserNavigate', 'BrowserReadPage', 'BrowserReadElement', 'BrowserFindText', 'BrowserClick', 'BrowserType', 'BrowserSelectOption', 'BrowserScroll', 'BrowserEvaluate', 'BrowserUpload'].map(name => declareTool({ name, description: async () => name, call: async () => ({ data: null }) }))
  const page = (url = 'http://localhost:3000/', tab = 7, elements: Record<string, unknown>[] = [{ index: 2, type: 'button', text: 'Save' }]) => ({ data: { ok: true, tab_id: tab, page_text: 'Saved', observation: { tabs: [{ tab_id: tab, url, elements }] } } })
  const call = vi.fn<(name: string, args: Record<string, unknown>) => Promise<unknown>>(async () => page())
  const record = vi.fn(async (_event: BehaviorExecution) => {})
  const authorize = vi.fn<(name: string, args: Record<string, unknown>, approval?: VerificationBrowserApproval) => Promise<boolean>>(async () => true)
  const controller = new AbortController()
  const tools = createVerificationBrowserTools({ url: 'http://localhost:3000/', available, call, record, authorize, signal: controller.signal, sanitize: text => text })
  const invoke = (name: string, args: Record<string, unknown>) => tools.find(t => t.name === name)!.call(args, { cancelSource: controller } as ToolCallContext, () => ({ behavior: 'allow' }), {} as Message)
  return { tools, call, record, authorize, invoke, page, controller }
}

describe('local verification browser boundary', () => {
  it('does not expose evaluate, uploads, or arbitrary browser capabilities', () => {
    expect(fixture().tools.map(t => t.name)).toEqual(['BrowserNavigate', 'BrowserReadPage', 'BrowserReadElement', 'BrowserFindText', 'BrowserClick', 'BrowserType', 'BrowserSelectOption', 'BrowserScroll'])
  })
  it('opens a fresh tab and records actual interactions separately from navigation', async () => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    expect(f.call).toHaveBeenCalledWith('BrowserNavigate', expect.objectContaining({ new_tab: true }))
    await f.invoke('BrowserClick', { index: 2 })
    expect(f.record.mock.calls.map(([event]) => event.interaction)).toEqual([false, true])
    expect(f.call).toHaveBeenCalledWith('BrowserReadPage', expect.objectContaining({ include_observation: true }))
  })
  it('rejects external navigation and interaction before local navigation', async () => {
    const f = fixture()
    await expect(f.invoke('BrowserNavigate', { url: 'https://example.test/' })).rejects.toThrow('verification-local-url-required')
    await expect(f.invoke('BrowserClick', { index: 2 })).rejects.toThrow('verification-navigation-required')
    expect(f.call).not.toHaveBeenCalled()
  })
  it('blocks interactions after another tab becomes active', async () => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    f.call.mockResolvedValue(f.page('http://localhost:3000/', 8))
    await expect(f.invoke('BrowserClick', { index: 2 })).rejects.toThrow('verification-tab-mismatch')
    expect(f.call.mock.calls.filter(([name]) => name === 'BrowserClick')).toHaveLength(0)
  })
  it('does not dispatch after cancellation while approval is pending', async () => {
    const f = fixture()
    const approval = Promise.withResolvers<boolean>()
    f.authorize.mockImplementation(() => approval.promise)
    const pending = f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    f.controller.abort()
    approval.resolve(true)
    await expect(pending).rejects.toThrow('verification-not-authorized')
    expect(f.call).not.toHaveBeenCalled()
  })
  it('records page text rather than response metadata as assertion evidence', async () => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    expect(f.record.mock.calls[0][0].observation).toBe('Saved')
    expect(f.record.mock.calls[0][0].observation).not.toContain('ok')
  })
  it('binds one action approval to the exact observed target and refreshes before dispatch', async () => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    f.call.mockClear()
    f.authorize.mockClear()
    await f.invoke('BrowserClick', { index: 2 })
    const approvals = f.authorize.mock.calls.filter(([name]) => name === 'BrowserClick')
    expect(approvals).toEqual([['BrowserClick', { index: 2 }, {
      tabId: 7, url: 'http://localhost:3000/', target: { index: 2, type: 'button', text: 'Save' },
      warning: expect.stringContaining('may contact its configured services'),
    }]])
    expect(f.call.mock.calls.map(([name]) => name)).toEqual(['BrowserReadPage', 'BrowserReadPage', 'BrowserClick', 'BrowserReadPage'])
  })
  it.each([
    { index: 3 }, { index: -1 }, { index: 2.5 }, { index: '2' }, {},
  ])('rejects targets absent from the fresh tab observation: %j', async args => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    await expect(f.invoke('BrowserClick', args)).rejects.toThrow('verification-target-unavailable')
    expect(f.authorize.mock.calls.some(([name]) => name === 'BrowserClick')).toBe(false)
    expect(f.call.mock.calls.some(([name]) => name === 'BrowserClick')).toBe(false)
  })
  it.each([
    { href: 'https://production.example/write' }, { href: '//example.test/' },
    { href: 'javascript:submit()' }, { href: 'http://user:pass@localhost:3000/' },
    { href: '/safe', href_truncated: true }, { href: 'http://[' },
  ])('rejects visible unsafe or truncated destinations: %j', async destination => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    f.call.mockResolvedValue(f.page('http://localhost:3000/', 7, [{ index: 2, type: 'link', ...destination }]))
    await expect(f.invoke('BrowserClick', { index: 2 })).rejects.toThrow('verification-target-destination-not-local')
    expect(f.authorize.mock.calls.some(([name]) => name === 'BrowserClick')).toBe(false)
    expect(f.call.mock.calls.some(([name]) => name === 'BrowserClick')).toBe(false)
  })
  it('allows an approved relative local link resolved against the current page', async () => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    f.call.mockResolvedValue(f.page('http://localhost:3000/app/list', 7, [{ index: 2, type: 'link', href: '../detail' }]))
    await f.invoke('BrowserClick', { index: 2 })
    expect(f.call).toHaveBeenCalledWith('BrowserClick', { index: 2 })
  })
  it.each(['target', 'tab', 'url', 'removed'])('refuses dispatch when %s changes during approval', async changed => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    f.authorize.mockImplementation(async name => {
      if (name === 'BrowserClick') f.call.mockResolvedValue(f.page(
        changed === 'url' ? 'http://localhost:3000/other' : 'http://localhost:3000/',
        changed === 'tab' ? 8 : 7,
        changed === 'removed' ? [] : [{ index: 2, type: 'button', text: changed === 'target' ? 'Delete' : 'Save' }],
      ))
      return true
    })
    await expect(f.invoke('BrowserClick', { index: 2 })).rejects.toThrow(/verification-(target-changed|target-unavailable|tab-mismatch)/)
    expect(f.call.mock.calls.some(([name]) => name === 'BrowserClick')).toBe(false)
  })
  it('cannot mutate the approved arguments through the approval callback', async () => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    f.authorize.mockImplementation(async (name, args, approval) => {
      if (name === 'BrowserType') { args.text = 'changed'; approval!.target!.text = 'changed' }
      return true
    })
    await f.invoke('BrowserType', { index: 2, text: 'test', submit: false })
    expect(f.call).toHaveBeenCalledWith('BrowserType', { index: 2, text: 'test', submit: false })
  })
  it('binds viewport scrolling to the tab without inventing an element index', async () => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    await f.invoke('BrowserScroll', { direction: 'down' })
    expect(f.authorize).toHaveBeenCalledWith('BrowserScroll', { direction: 'down' }, { tabId: 7, url: 'http://localhost:3000/', warning: expect.any(String) })
  })
  it('accepts native element-read results without a page envelope and validates a subsequent page read', async () => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    f.call.mockImplementation(async name => name === 'BrowserReadElement'
      ? { ok: true, action: 'read_element', index: 2, type: 'button', element_text: 'Saved item details', truncated: false }
      : f.page())
    const result = await f.invoke('BrowserReadElement', { index: 2 })
    expect(result.data).toMatchObject({ assertionText: 'Saved\nSaved item details' })
    expect(f.record.mock.calls.at(-1)![0]).toMatchObject({ succeeded: true, interaction: false, observation: 'Saved\nSaved item details' })
    expect(f.call.mock.calls.at(-1)![0]).toBe('BrowserReadPage')
  })
  it('does not admit an echoed search query with no matches as evidence', async () => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    f.call.mockImplementation(async name => name === 'BrowserFindText'
      ? { ok: true, action: 'find_text', query: 'invented success', matches: [] }
      : f.page())
    const result = await f.invoke('BrowserFindText', { query: 'invented success' })
    expect(result.data).toMatchObject({ assertionText: 'Saved' })
    expect(f.record.mock.calls.at(-1)![0].observation).not.toContain('invented success')
  })
  it('does not dispatch when the model is cancelled during the post-approval refresh', async () => {
    const f = fixture()
    await f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })
    const model = new AbortController()
    let approved = false
    f.authorize.mockImplementation(async name => {
      if (name === 'BrowserClick') approved = true
      else if (approved && name === 'BrowserReadPage') model.abort()
      return true
    })
    const tool = f.tools.find(tool => tool.name === 'BrowserClick')!
    await expect(tool.call({ index: 2 }, { cancelSource: model } as ToolCallContext, () => ({ behavior: 'allow' }), {} as Message)).rejects.toThrow('verification-not-authorized')
    expect(f.controller.signal.aborted).toBe(false)
    expect(f.call.mock.calls.some(([name]) => name === 'BrowserClick')).toBe(false)
  })
  it('requires approval for each actual action', async () => {
    const f = fixture()
    f.authorize.mockResolvedValue(false)
    await expect(f.invoke('BrowserNavigate', { url: 'http://localhost:3000/' })).rejects.toThrow('verification-not-authorized')
    expect(f.call).not.toHaveBeenCalled()
    expect(f.record).not.toHaveBeenCalled()
  })
})
