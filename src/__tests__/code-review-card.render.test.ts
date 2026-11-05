import { RightPanelContentContext } from '../components/assistant-ui/right-panel-content-context'
// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CodeReviewCard, CodeReviewProvider, CodeReviewRow, ReviewReportCard, currentReviewLocation, reviewFindingState } from '../components/assistant-ui/code-review-card'
import type { ReviewReportView, ReviewSessionSnapshot } from '../codeReview/review-protocol'
import { createTranslate } from '../browser/webview/i18n/translate'
import { writeClipboard } from '../utils/clipboard'
vi.mock('../utils/clipboard', () => ({ writeClipboard: vi.fn(async () => true) }))
const t = createTranslate('en')
afterEach(cleanup)
function report(): ReviewReportView {
  return {
    run: { id: 'r1', conversationKey: 's1', scope: { kind: 'workspace', workspaceKey: 'w', repository: { projectKey: 'repo' }, revision: { base: 'a', head: 'b' }, pathFilter: [] }, policy: { level: 'medium', recipe: 'local-eight', recipeRevision: 1, execution: 'isolated', presentation: 'panel', reportLimit: 8 }, progress: { status: 'partial', stage: 'report', coveredAngles: [], unavailableAngles: [], spawnedTasks: 0, verifiedCandidates: 0, omittedByLimit: 0 }, reportRevision: 1 },
    diagnostics: [], evidence: [], assessments: [], actions: [], coverage: { complete: false, angles: [], limitations: ['Not inspected'] }, permissions: { publish: true, publishConfirmation: true },
  }
}
function renderReport(value = report(), enabled = true) {
  const onAction = vi.fn(async () => {})
  render(createElement(ReviewReportCard, { report: value, can: () => enabled, onAction }))
  return onAction
}
/** Open the card's more-actions menu and return it. */
async function openMore(): Promise<HTMLElement> {
  const trigger = screen.getByTestId('review-more')
  fireEvent.pointerDown(trigger)
  fireEvent.click(trigger)
  return (await screen.findByRole('menu')) as HTMLElement
}
const menuDisabled = (id: string) => screen.getByTestId(id).hasAttribute('data-disabled')
describe('review report card', () => {
  it('holds a transcript-row card to the thread text column', () => {
    render(createElement(CodeReviewRow, { runId: 'r1' }))
    const row = screen.getByTestId('code-review-row')
    expect(row.contains(screen.getByTestId('code-review-card'))).toBe(true)
    expect(row.className.split(' ')).toEqual(expect.arrayContaining(['mx-auto', 'w-full', 'max-w-(--thread-max-width)', 'px-2']))
  })
  it('distinguishes incomplete zero findings, complete zero findings and empty scope', () => {
    const value = report()
    renderReport(value)
    expect(screen.getByTestId('review-empty').textContent).toBe(t('reviewCard.emptyPartial'))
    cleanup()
    value.coverage.complete = true
    value.run.progress.status = 'finished'
    renderReport(value)
    expect(screen.getByTestId('review-empty').textContent).toBe(t('reviewCard.emptyComplete'))
    cleanup()
    value.emptyScope = true
    renderReport(value)
    expect(screen.getByTestId('review-empty').textContent).toBe(t('reviewCard.emptyScope'))
  })
  it('publishes only after confirmation when host policy requires it', async () => {
    const action = renderReport()
    await openMore()
    fireEvent.click(screen.getByTestId('review-publish'))
    expect(action).not.toHaveBeenCalled()
    const group = screen.getByRole('group', { name: t('reviewCard.confirm') })
    fireEvent.click(group.querySelector('button')!)
    await waitFor(() => expect(action).toHaveBeenCalledWith('publish', { preview: false, confirmed: true }))
  })
  it('does not impose confirmation when host policy does not require it; preview never writes', async () => {
    const value = report()
    value.permissions!.publishConfirmation = false
    const action = renderReport(value)
    await openMore()
    fireEvent.click(screen.getByTestId('review-preview'))
    await waitFor(() => expect(action).toHaveBeenCalledWith('publish', { preview: true, confirmed: false }))
    await openMore()
    await waitFor(() => expect(menuDisabled('review-publish')).toBe(false))
    fireEvent.click(screen.getByTestId('review-publish'))
    await waitFor(() => expect(action).toHaveBeenCalledWith('publish', { preview: false, confirmed: false }))
  })
  it('disables unavailable actions and collapse never cancels', async () => {
    const action = renderReport(report(), false)
    expect(screen.queryByTestId('review-cancel')).toBeNull()
    expect((screen.getByTestId('review-rerun') as HTMLButtonElement).disabled).toBe(true)
    // Nothing to repair: no Repair button at all.
    expect(screen.queryByTestId('review-repair')).toBeNull()
    await openMore()
    for (const id of ['publish', 'preview', 'verify']) expect(menuDisabled(`review-${id}`)).toBe(true)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    fireEvent.click(screen.getByLabelText(t('reviewCard.collapse')))
    expect(action).not.toHaveBeenCalled()
    expect(screen.queryByTestId('review-empty')).toBeNull()
    expect(screen.queryByTestId('review-repair')).toBeNull()
    fireEvent.click(screen.getByLabelText(t('reviewCard.expand')))
    expect(screen.getByTestId('review-empty')).toBeTruthy()
  })
  it('shows stages and only cancel while the review runs, and keeps findings through a follow-up stage', () => {
    const value = report()
    value.diagnostics = [{ id: 'd1', runId: 'r1', anchor: { path: 'src/a.ts', revision: 'b', side: 'working-copy', span: { start: 2, end: 2 } }, claim: { title: 'Unsafe branch', explanation: 'Mechanism', trigger: 'Input' }, classification: { kind: 'security', impact: 'major' }, evidenceKeys: [], origin: { angle: 'lines' } }]
    value.permissions = { cancel: true, repair: true, rerun: true, publish: true }
    value.run.progress.status = 'active'
    value.run.progress.stage = 'inspect'
    const action = renderReport(value)
    const stages = screen.getByTestId('review-stages')
    expect(Array.from(stages.querySelectorAll('li')).map(item => item.dataset.state)).toEqual(['done', 'current', 'pending'])
    expect(screen.getByTestId('code-review-card').dataset.status).toBe('active')
    expect(screen.queryByTestId('review-finding')).toBeNull()
    expect(screen.queryByTestId('review-empty')).toBeNull()
    expect(screen.queryByTestId('review-count')).toBeNull()
    expect(screen.queryByTestId('review-repair')).toBeNull()
    expect(screen.queryByTestId('review-rerun')).toBeNull()
    expect(screen.queryByTestId('review-more')).toBeNull()
    fireEvent.click(screen.getByTestId('review-cancel'))
    expect(action).toHaveBeenCalledWith('cancel', undefined)
    cleanup()
    value.run.progress.stage = 'repair'
    renderReport(value)
    expect(screen.queryByTestId('review-stages')).toBeNull()
    expect(screen.getByTestId('review-finding')).toBeTruthy()
    expect(screen.getByTestId('review-cancel')).toBeTruthy()
    expect(screen.queryByTestId('review-repair')).toBeNull()
    cleanup()
    value.run.progress.status = 'queued'
    value.run.progress.stage = 'scope'
    renderReport(value)
    expect(Array.from(screen.getByTestId('review-stages').querySelectorAll('li')).map(item => item.dataset.state)).toEqual(['pending', 'pending', 'pending'])
  })
  it('shows a team run its find, merge, verify and sweep steps, and the summary once the sweep is done', () => {
    const value = report()
    value.run.policy = { ...value.run.policy, recipe: 'team-ten' }
    value.run.progress.status = 'active'
    const states = (stage: ReviewReportView['run']['progress']['stage']) => {
      value.run.progress.stage = stage
      renderReport(value)
      const items = Array.from(screen.getByTestId('review-stages').querySelectorAll('li'))
      const result = [items.map(item => item.textContent).join(','), items.findIndex(item => item.dataset.state === 'current')]
      cleanup()
      return result
    }
    expect(states('inspect')).toEqual(['Prepare,Find,Merge,Verify,Sweep,Summarize', 1])
    expect(states('merge')[1]).toBe(2)
    expect(states('assess')[1]).toBe(3)
    expect(states('sweep')[1]).toBe(4)
    expect(states('report')[1]).toBe(5)
    value.run.policy = { ...value.run.policy, recipe: 'team-eight-recall' }
    expect(states('report')).toEqual(['Prepare,Find,Merge,Verify,Summarize', 4])
  })
  it('counts findings by severity and flags incomplete coverage next to them', () => {
    const value = report()
    const finding = (id: string, impact: 'critical' | 'major' | 'minor') => ({ id, runId: 'r1', anchor: { path: 'src/a.ts', revision: 'b', side: 'working-copy' as const }, claim: { title: id, explanation: 'Mechanism', trigger: 'Input' }, classification: { kind: 'correctness' as const, impact }, evidenceKeys: [], origin: { angle: 'lines' } })
    value.diagnostics = [finding('d1', 'critical'), finding('d2', 'minor'), finding('d3', 'minor')]
    value.run.progress.omittedByLimit = 2
    renderReport(value)
    expect(screen.getByTestId('review-count').textContent).toBe(t('reviewCard.findingsMany', { count: 3 }))
    expect(screen.getByText(t('reviewCard.omitted', { omitted: 2 }))).toBeTruthy()
    expect(screen.getByText(`${t('reviewCard.value.critical')} · 1`)).toBeTruthy()
    expect(screen.getByText(`${t('reviewCard.value.minor')} · 2`)).toBeTruthy()
    expect(screen.queryByText(`${t('reviewCard.value.major')} · 0`)).toBeNull()
    expect(screen.getByTestId('review-incomplete')).toBeTruthy()
    expect(screen.queryByTestId('review-empty')).toBeNull()
    fireEvent.click(screen.getByLabelText(t('reviewCard.select', { title: 'd1' })))
    expect(screen.getByTestId('review-repair').textContent).toBe(t('reviewCard.repairCount', { count: 1 }))
    expect(screen.getByText(t('reviewCard.selected', { count: 1 }))).toBeTruthy()
    cleanup()
    value.diagnostics = [finding('d1', 'major')]
    value.run.progress.omittedByLimit = 0
    value.coverage.complete = true
    renderReport(value)
    expect(screen.getByTestId('review-count').textContent).toBe(t('reviewCard.findingsOne'))
    expect(screen.queryByTestId('review-incomplete')).toBeNull()
    expect(screen.queryByText(t('reviewCard.omitted', { omitted: 0 }))).toBeNull()
  })
  it('filters findings, selects repairs and refuses historical line jumps', async () => {
    const value = report()
    value.diagnostics = [{ id: 'd1', runId: 'r1', anchor: { path: 'src/a.ts', revision: 'old', side: 'before', span: { start: 2, end: 2 } }, claim: { title: 'Unsafe branch', explanation: 'Mechanism', trigger: 'Input' }, classification: { kind: 'security', impact: 'major' }, evidenceKeys: [], origin: { angle: 'lines' } }]
    const action = renderReport(value)
    expect((screen.getByText('src/a.ts:2') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(t('reviewCard.severity')), { target: { value: 'minor' } })
    expect(screen.queryByTestId('review-finding')).toBeNull()
    fireEvent.change(screen.getByLabelText(t('reviewCard.severity')), { target: { value: 'all' } })
    fireEvent.click(screen.getByLabelText(t('reviewCard.select', { title: 'Unsafe branch' })))
    fireEvent.click(screen.getByTestId('review-repair'))
    await waitFor(() => expect(action).toHaveBeenCalledWith('repair', { diagnosticIds: ['d1'] }))
    expect(currentReviewLocation(value, value.diagnostics[0]!)).toBe(false)
    value.actions.push({ id: 'a1', kind: 'repair', state: 'applied', diagnosticIds: ['d1'], verification: 'not-run' })
    expect(reviewFindingState(value, 'd1')).toBe('applied')
    value.actions[0]!.verification = 'passed'
    expect(reviewFindingState(value, 'd1')).toBe('verified')
  })
})

it('selects every shown finding at once, and offers no selection where repair is not available', async () => {
  const value = report()
  value.diagnostics = ['d1', 'd2'].map(id => ({ id, runId: 'r1', anchor: { path: 'src/a.ts', revision: 'b', side: 'working-copy' as const, span: { start: 2, end: 2 } }, claim: { title: `Finding ${id}`, explanation: 'Mechanism', trigger: 'Input' }, classification: { kind: 'correctness' as const, impact: 'major' as const }, evidenceKeys: [], origin: { angle: 'lines' } }))
  value.permissions = { ...value.permissions, repair: true }
  const action = renderReport(value)
  fireEvent.click(screen.getByTestId('review-select-all'))
  expect(screen.getAllByRole('checkbox').map(box => (box as HTMLInputElement).checked)).toEqual([true, true, true])
  fireEvent.click(screen.getByTestId('review-repair'))
  await waitFor(() => expect(action).toHaveBeenCalledWith('repair', { diagnosticIds: ['d1', 'd2'] }))
  fireEvent.click(screen.getByTestId('review-select-all'))
  expect(screen.getAllByRole('checkbox').map(box => (box as HTMLInputElement).checked)).toEqual([false, false, false])
  cleanup()
  value.permissions = { ...value.permissions, repair: false }
  const noRepair = () => render(createElement(ReviewReportCard, { report: value, can: action => action !== 'repair', onAction: vi.fn(async () => {}) }))
  noRepair()
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  expect(screen.queryByTestId('review-repair')).toBeNull()
  // A working-copy review without repair (a stored or unstructured report) is not told it needs a working copy.
  expect(screen.queryByTestId('review-repair-unavailable')).toBeNull()
  cleanup()
  value.run.scope = { ...value.run.scope, kind: 'range' }
  noRepair()
  expect(screen.getByTestId('review-repair-unavailable').textContent).toBe(t('reviewCard.repairUnavailable'))
  expect(screen.getByTestId('review-rerun')).toBeTruthy()
})
it('lists unverified items apart from the findings, with no repair selection', () => {
  const value = { ...report(), unverified: [{ id: 'u1', headline: 'Handle leaks on throw', details: 'The release call is gone.', path: 'src/a.ts', line: 5, impact: 'major' as const, code: 'quote-not-in-source' }] }
  renderReport(value)
  const section = screen.getByTestId('review-unverified')
  expect(section.textContent).toContain(t('reviewCard.unverified'))
  expect(section.textContent).toContain(t('reviewCard.unverifiedNote'))
  expect(screen.getByTestId('review-unverified-item').textContent).toContain('Handle leaks on throw')
  expect(screen.getByTestId('review-unverified-item').textContent).toContain('src/a.ts:5')
  expect(section.textContent).not.toContain('quote-not-in-source')
  expect(section.querySelector('input[type="checkbox"]')).toBeNull()
  expect(screen.queryAllByTestId('review-finding')).toHaveLength(0)
})
it('renders structured policy notices and coded coverage without leaking identifiers', () => {
  const value = report()
  value.notices = [{ code: 'level-reused', level: 'high' }, { code: 'panel-limit', requested: 'unlimited', effective: 32 }]
  value.coverage.limitations = ['other-untracked-files-excluded', 'scope-incomplete']
  value.run.progress.unavailableAngles = ['removed']
  renderReport(value)
  expect(screen.getByTestId('review-notices').textContent).toContain(t('reviewCard.notice.levelReused', { level: t('reviewCard.value.high') }))
  expect(screen.getByText(t('reviewCard.notice.untracked'))).toBeTruthy()
  expect(screen.getByText(t('reviewCard.uncovered', { angles: t('reviewCard.angle.removed') }))).toBeTruthy()
  expect(screen.getByTestId('code-review-card').textContent).not.toContain('scope-incomplete')
})

it('sends the selected presentation for rereview and shows only exact host-generated JSON', async () => {
  const value = report()
  value.exportJson = '{\n  "report": "<safe>", "actions": []\n}\n'
  const action = renderReport(value)
  expect(screen.getByTestId('review-export-json').textContent).toBe(value.exportJson)
  await openMore()
  expect(screen.getByTestId('review-output-panel').getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByTestId('review-output-json'))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  fireEvent.click(screen.getByTestId('review-rerun'))
  await waitFor(() => expect(action).toHaveBeenCalledWith('rerun', { presentation: 'json' }))
})
it('requires an explicit verify permission and sends no commands with verification', async () => {
  const value = report()
  renderReport(value)
  await openMore()
  expect(menuDisabled('review-verify')).toBe(true)
  expect(screen.queryByTestId('review-export-json')).toBeNull()
  cleanup()
  value.permissions!.verify = true
  const action = renderReport(value)
  await openMore()
  fireEvent.click(screen.getByTestId('review-verify'))
  await waitFor(() => expect(action).toHaveBeenCalledWith('verify', undefined))
  cleanup()
  renderReport(value, false)
  await openMore()
  expect(menuDisabled('review-verify')).toBe(true)
})

it('opens only the fresh runtime locator and never the report path or historical line', async () => {
  const value = report()
  value.permissions!.locate = true
  value.diagnostics = [{ id: 'd1', runId: 'r1', anchor: { path: 'old.ts', revision: 'b', side: 'working-copy', span: { start: 2, end: 2 } }, claim: { title: 'Issue', explanation: 'Details', trigger: 'Input' }, classification: { kind: 'correctness', impact: 'major' }, evidenceKeys: [], origin: { angle: 'lines' } }]
  const openFile = vi.fn()
  let resolve!: (value: unknown) => void
  const onAction = vi.fn(() => new Promise<unknown>(done => { resolve = done }))
  render(createElement(RightPanelContentContext.Provider, { value: { openFile } }, createElement(ReviewReportCard, { report: value, can: () => true, onAction })))
  fireEvent.click(screen.getByText('old.ts:2'))
  expect(onAction).toHaveBeenCalledWith('locate', { diagnosticId: 'd1' })
  expect(openFile).not.toHaveBeenCalled()
  resolve({ path: '/repo/current.ts', line: 17 })
  await waitFor(() => expect(openFile).toHaveBeenCalledWith({ path: '/repo/current.ts', line: 17 }))
  cleanup()
  openFile.mockClear()
  value.diagnostics[0]!.anchor.side = 'before'
  render(createElement(RightPanelContentContext.Provider, { value: { openFile } }, createElement(ReviewReportCard, { report: value, can: () => true, onAction })))
  expect((screen.getByText('old.ts:2') as HTMLButtonElement).disabled).toBe(true)
  expect(openFile).not.toHaveBeenCalled()
})


it('checks capability and action separately on the real connection-shaped card', async () => {
  const value = report()
  value.permissions!.rerun = true
  const can = vi.fn((cap: string, action?: string) => cap === 'review' && action === 'rerun')
  const request = vi.fn(async () => ({ runId: 'r2' }))
  const connection = { can, request, subscribe: (_topic: string, listener: (event: unknown) => void) => { listener({ payload: { sessionId: 's1', sequence: 1, reports: [value] } }); return () => {} } }
  render(createElement(CodeReviewProvider, { value: { sessionId: 's1', connection: async () => connection as never } }, createElement(CodeReviewCard, { runId: 'r1' })))
  await waitFor(() => expect((screen.getByTestId('review-rerun') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByTestId('review-rerun'))
  await waitFor(() => expect(request).toHaveBeenCalledWith('review.rerun', { sessionId: 's1', runId: 'r1', presentation: 'panel' }))
  expect(can).toHaveBeenCalledWith('review', 'rerun')
})

it('defaults GitLab publication to summary and carries explicit discussion intent through preview and confirmation', async () => {
  const value = report()
  value.run.scope.repository.platform = 'gitlab'
  const action = renderReport(value)
  await openMore()
  const checkbox = () => screen.getByTestId('review-discussions')
  expect(checkbox().getAttribute('aria-checked')).toBe('false')
  fireEvent.click(screen.getByTestId('review-preview'))
  await waitFor(() => expect(action).toHaveBeenCalledWith('publish', { preview: true, confirmed: false, discussions: false }))
  await openMore()
  await waitFor(() => expect(menuDisabled('review-discussions')).toBe(false))
  fireEvent.click(checkbox())
  expect(screen.getByRole('menu')).toBeTruthy()
  await waitFor(() => expect(checkbox().getAttribute('aria-checked')).toBe('true'))
  fireEvent.click(screen.getByTestId('review-preview'))
  await waitFor(() => expect(action).toHaveBeenCalledWith('publish', { preview: true, confirmed: false, discussions: true }))
  await openMore()
  await waitFor(() => expect(menuDisabled('review-publish')).toBe(false))
  fireEvent.click(screen.getByTestId('review-publish'))
  await openMore()
  expect(menuDisabled('review-discussions')).toBe(true)
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  fireEvent.click(screen.getByRole('group', { name: t('reviewCard.confirm') }).querySelector('button')!)
  await waitFor(() => expect(action).toHaveBeenCalledWith('publish', { preview: false, confirmed: true, discussions: true }))
  cleanup()
  value.run.scope.repository.platform = 'github'
  renderReport(value)
  await openMore()
  expect(screen.queryByTestId('review-discussions')).toBeNull()
})

describe('a model-requested review found by its Skill call', () => {
  const rigCard = (snapshot: Partial<ReviewSessionSnapshot>, props: Record<string, unknown>, allow = true) => {
    const request = vi.fn(async () => ({ accepted: true }))
    const connection = { can: vi.fn(() => allow), request, subscribe: (_topic: string, listener: (event: unknown) => void) => { listener({ payload: { sessionId: 's1', sequence: 1, reports: [], ...snapshot } }); return () => {} } }
    render(createElement(CodeReviewProvider, { value: { sessionId: 's1', connection: async () => connection as never } }, createElement(CodeReviewCard, props as never)))
    return request
  }
  it('shows the run the call started, before the call returns a run id', async () => {
    const value = report()
    value.run.toolCallId = 'call-1'
    value.run.progress.status = 'active'
    value.run.progress.stage = 'inspect'
    const other = { ...report(), run: { ...report().run, id: 'r2', toolCallId: 'call-2' } }
    rigCard({ reports: [other, value] }, { toolCallId: 'call-1', starting: true })
    await waitFor(() => expect(screen.getByTestId('code-review-card').dataset.status).toBe('active'))
    expect(screen.getByTestId('review-stages')).toBeTruthy()
  })
  it('stands in a preparing card that cancels by the preparing id while the run does not exist', async () => {
    const request = rigCard({ preparing: [{ id: 'preparing-1', toolCallId: 'call-1' }] }, { toolCallId: 'call-1', starting: true })
    await waitFor(() => expect((screen.getByTestId('review-cancel') as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByTestId('code-review-card').dataset.status).toBe('preparing')
    expect(screen.getByTestId('review-preparing').textContent).toBe(t('reviewCard.preparing'))
    fireEvent.click(screen.getByTestId('review-cancel'))
    await waitFor(() => expect(request).toHaveBeenCalledWith('review.cancel', { sessionId: 's1', runId: 'preparing-1' }))
  })
  it('keeps the preparing card, without cancel, before the runtime lists the call or for an observer', async () => {
    rigCard({}, { toolCallId: 'call-1', starting: true })
    await waitFor(() => expect(screen.getByTestId('code-review-card').dataset.status).toBe('preparing'))
    expect((screen.getByTestId('review-cancel') as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    rigCard({ preparing: [{ id: 'preparing-1', toolCallId: 'call-1' }] }, { toolCallId: 'call-1', starting: true }, false)
    await waitFor(() => expect(screen.getByTestId('code-review-card').dataset.status).toBe('preparing'))
    expect((screen.getByTestId('review-cancel') as HTMLButtonElement).disabled).toBe(true)
  })
  it('gives every card the snapshot, though the runtime sends it to a topic\'s first subscriber only', async () => {
    const first = report()
    first.run.toolCallId = 'call-1'
    const second = { ...report(), run: { ...report().run, id: 'r2', toolCallId: 'call-2' } }
    const listeners: Array<(event: unknown) => void> = []
    const subscribe = vi.fn((_topic: string, listener: (event: unknown) => void) => {
      listeners.push(listener)
      if (listeners.length === 1) listener({ payload: { sessionId: 's1', sequence: 1, reports: [first, second] } })
      return () => { listeners.splice(listeners.indexOf(listener), 1) }
    })
    const connection = { can: vi.fn(() => true), request: vi.fn(), subscribe }
    render(createElement(CodeReviewProvider, { value: { sessionId: 's1', connection: async () => connection as never } },
      createElement(CodeReviewCard, { toolCallId: 'call-1' }), createElement(CodeReviewCard, { toolCallId: 'call-2' })))
    await waitFor(() => expect(screen.getAllByTestId('code-review-card').map(card => card.dataset.status)).toEqual(['partial', 'partial']))
    expect(subscribe).toHaveBeenCalledTimes(1)
  })
  it('gives up the preparing card for the fallback once a later snapshot still lists nothing for the call', async () => {
    let publish: ((event: unknown) => void) | undefined
    const connection = { can: vi.fn(() => true), request: vi.fn(), subscribe: (_topic: string, listener: (event: unknown) => void) => { publish = listener; listener({ payload: { sessionId: 's1', sequence: 1, reports: [] } }); return () => {} } }
    render(createElement(CodeReviewProvider, { value: { sessionId: 's1', connection: async () => connection as never } },
      createElement(CodeReviewCard, { toolCallId: 'call-1', starting: true, fallback: createElement('p', { 'data-testid': 'plain-row' }) })))
    await waitFor(() => expect(publish).toBeTypeOf('function'))
    expect(screen.getByTestId('code-review-card').dataset.status).toBe('preparing')
    act(() => publish!({ payload: { sessionId: 's1', sequence: 2, reports: [] } }))
    expect(await screen.findByTestId('plain-row')).toBeTruthy()
    act(() => publish!({ payload: { sessionId: 's1', sequence: 3, reports: [], preparing: [{ id: 'preparing-1', toolCallId: 'call-1' }] } }))
    await waitFor(() => expect(screen.getByTestId('code-review-card').dataset.status).toBe('preparing'))
  })
  it('renders the fallback for a settled call that started no run', async () => {
    rigCard({}, { toolCallId: 'call-1', starting: false, fallback: createElement('p', { 'data-testid': 'plain-row' }) })
    expect(await screen.findByTestId('plain-row')).toBeTruthy()
    expect(screen.queryByTestId('code-review-card')).toBeNull()
  })
})

it('counts candidates and verified candidates while the review is active, without showing findings', () => {
  const value = report()
  value.diagnostics = [{ id: 'd1', runId: 'r1', anchor: { path: 'src/a.ts', revision: 'b', side: 'working-copy', span: { start: 2, end: 2 } }, claim: { title: 'Unsafe branch', explanation: 'Mechanism', trigger: 'Input' }, classification: { kind: 'security', impact: 'major' }, evidenceKeys: [], origin: { angle: 'lines' } }]
  value.assessments = [
    { id: 'a1', diagnosticId: 'd2', disposition: 'plausible', rationale: 'Looks real', evidenceKeys: [] },
    { id: 'a2', diagnosticId: 'd2', disposition: 'dismissed', rationale: 'Guard present', evidenceKeys: [] },
    { id: 'a3', diagnosticId: 'd1', disposition: 'proven', rationale: 'Reproduced', evidenceKeys: [] },
  ]
  value.run.progress = { ...value.run.progress, status: 'active', stage: 'assess', verifiedCandidates: 3, omittedByLimit: 2 }
  renderReport(value)
  // One retained, two over the report limit, one dismissed: verified never outruns found.
  expect(screen.getByTestId('review-progress').textContent).toBe(t('reviewCard.progressFound', { found: 4, verified: 3 }))
  expect(screen.queryByTestId('review-finding')).toBeNull()
  cleanup()
  value.run.progress.status = 'queued'
  renderReport(value)
  expect(screen.queryByTestId('review-progress')).toBeNull()
})

it('uses the singular progress line for exactly one candidate', () => {
  const value = report()
  value.run.progress = { ...value.run.progress, status: 'active', stage: 'assess', verifiedCandidates: 0, omittedByLimit: 0 }
  value.diagnostics = [{ id: 'd1', runId: 'r1', anchor: { path: 'src/a.ts', revision: 'b', side: 'working-copy', span: { start: 2, end: 2 } }, claim: { title: 'Unsafe branch', explanation: 'Mechanism', trigger: 'Input' }, classification: { kind: 'security', impact: 'major' }, evidenceKeys: [], origin: { angle: 'lines' } }]
  value.assessments = []
  renderReport(value)
  expect(screen.getByTestId('review-progress').textContent).toBe(t('reviewCard.progressFoundOne', { verified: 0 }))
})

describe('review card header and live activity', () => {
  const base = `fb1669b${'0'.repeat(33)}`
  const head = `f5ecacb${'1'.repeat(33)}`
  function running(): ReviewReportView {
    const value = report()
    value.run.scope.revision = { base, head }
    value.run.policy = { ...value.run.policy, level: 'max' }
    value.targetLabel = `${base}..${head}`
    value.run.progress = { ...value.run.progress, status: 'active', stage: 'inspect' }
    value.permissions = { cancel: true }
    return value
  }
  it('keeps the level on the title line and shows the range short, full on focus', async () => {
    renderReport(running())
    const heading = screen.getByTestId('review-heading')
    expect(heading.querySelector('h3')!.textContent).toBe(t('reviewCard.title'))
    expect(heading.contains(screen.getByTestId('review-level'))).toBe(true)
    expect(screen.getByTestId('review-level').textContent).toBe(t('reviewCard.value.max'))
    expect(screen.getByTestId('review-range-short').textContent).toBe('fb1669b → f5ecacb')
    // A target label naming only the revisions adds nothing to the range.
    expect(screen.getByTestId('code-review-card').textContent).not.toContain(base)
    fireEvent.focus(screen.getByTestId('review-range-short'))
    expect((await screen.findByRole('tooltip')).textContent).toContain(`${base} → ${head}`)
  })
  it('appends a target label that says more than the revisions', () => {
    const value = running()
    value.targetLabel = './src/a.ts'
    renderReport(value)
    expect(screen.getByTestId('review-range').textContent).toContain('./src/a.ts')
  })
  it('copies the full pair without toggling the card', async () => {
    renderReport(running())
    fireEvent.click(screen.getByTestId('review-range-copy'))
    expect(writeClipboard).toHaveBeenCalledWith(`${base} → ${head}`)
    await waitFor(() => expect(screen.getByTestId('review-range-copy').getAttribute('aria-label')).toBe(t('messageMenu.copied')))
    expect(screen.getByTestId('review-toggle').getAttribute('aria-expanded')).toBe('true')
  })
  it('names the stage under the steps of an open running card, with the current step spinning and no footer', () => {
    renderReport(running())
    expect(screen.queryByTestId('review-status')).toBeNull()
    const line = screen.getByTestId('review-status-line')
    expect(line.firstElementChild!.firstChild!.textContent).toBe(t('reviewCard.value.inspect'))
    expect(line.querySelector('[aria-hidden].shimmer')!.textContent).toBe(t('reviewCard.value.inspect'))
    expect(screen.getByTestId('review-stages').querySelector('[data-state="current"] [data-testid="review-stage-spinner"]')).toBeTruthy()
    const card = screen.getByTestId('code-review-card')
    expect(card.textContent).not.toContain(t('reviewCard.value.active'))
    expect(card.querySelector('footer')).toBeNull()
    expect(screen.getByTestId('review-cancel')).toBeTruthy()
    expect(screen.getByTestId('review-progress').textContent).toBe(t('reviewCard.progressNone'))
  })
  it('keeps the same header collapsed, toggled by one button covering the row', () => {
    renderReport(running())
    const toggle = screen.getByTestId('review-toggle')
    expect(toggle.tagName).toBe('BUTTON')
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeTruthy()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // The body is gone, so nothing is referenced.
    expect(toggle.hasAttribute('aria-controls')).toBe(false)
    expect(screen.queryByTestId('review-stages')).toBeNull()
    for (const id of ['review-heading', 'review-level', 'review-range', 'review-status']) expect(screen.getByTestId(id)).toBeTruthy()
    // Collapsed, the header carries the spinner and the stage again.
    expect(screen.getByTestId('review-status').textContent).toBe(t('reviewCard.value.inspect'))
    expect(screen.getByTestId('review-status').querySelector('.animate-spin')).toBeTruthy()
  })
  it('shows the most recently active task and task counts, with the full tree folded', () => {
    const value = running()
    value.tasks = [
      { key: 'c', role: 'coordinator', status: 'running', startedAt: 1, lastActivityAt: 2, lastAction: 'ReviewLedger' },
      { key: 'f', role: 'finder', angles: ['calls'], status: 'running', startedAt: 1, lastActivityAt: 5, lastAction: 'ReviewRead diff src/a.ts' },
      { key: 'v', role: 'verifier', status: 'finished', startedAt: 1, lastActivityAt: 3, finishedAt: 4 },
    ]
    renderReport(value)
    const current = screen.getByTestId('review-current-task')
    expect(current.textContent).toContain(t('reviewCard.task.role.finder'))
    expect(current.textContent).toContain(t('reviewCard.angle.calls'))
    expect(current.textContent).toContain(t('reviewCard.task.lastAction', { action: 'ReviewRead diff src/a.ts' }))
    expect(screen.getByTestId('review-task-counts').textContent).toBe(t('reviewCard.tasksDone', { finished: 1, running: 2 }))
    cleanup()
    value.tasks[2] = { ...value.tasks[2], status: 'failed' }
    renderReport(value)
    // A failed task ended but did not finish.
    expect(screen.getByTestId('review-task-counts').textContent).toBe(`${t('reviewCard.tasksDone', { finished: 0, running: 2 })} · ${t('reviewCard.tasksNotCompleted', { count: 1 })}`)
    value.tasks[2] = { ...value.tasks[2], status: 'finished' }
    cleanup()
    renderReport(value)
    expect((screen.getByTestId('review-tasks') as HTMLDetailsElement).open).toBe(false)
    cleanup()
    value.run.progress.status = 'finished'
    value.run.progress.stage = 'report'
    value.tasks = value.tasks.map((task, index) => ({ ...task, status: index === 0 ? 'failed' : 'finished' }))
    renderReport(value)
    expect(screen.queryByTestId('review-activity')).toBeNull()
    const tree = screen.getByTestId('review-tasks') as HTMLDetailsElement
    expect(tree.open).toBe(false)
    expect(tree.querySelector('summary')!.textContent).toBe(`${t('reviewCard.tasks')} · ${t('reviewCard.tasksCompleted', { count: 2 })} · ${t('reviewCard.tasksNotCompleted', { count: 1 })}`)
  })
  it('keeps the method in review details while running, and in the scope block once finished', () => {
    const value = running()
    renderReport(value)
    expect(screen.getByTestId('review-details').contains(screen.getByTestId('review-method'))).toBe(true)
    cleanup()
    value.run.progress.status = 'finished'
    value.run.progress.stage = 'report'
    value.notices = [{ code: 'level-reused', level: 'high' }]
    renderReport(value)
    const scope = screen.getByTestId('review-scope')
    expect(scope.contains(screen.getByTestId('review-method'))).toBe(true)
    expect(scope.contains(screen.getByTestId('review-notices'))).toBe(true)
    expect(screen.getByTestId('review-method').textContent).toContain(t('reviewCard.revisionOnly'))
    expect(screen.getByTestId('review-details').querySelector('[data-testid="review-method"]')).toBeNull()
  })
  it('states a clean result as plain text under the count, with no Repair and no footer status', () => {
    const value = running()
    value.run.progress.status = 'finished'
    value.run.progress.stage = 'report'
    value.coverage.complete = true
    renderReport(value)
    const empty = screen.getByTestId('review-empty')
    expect(empty.textContent).toBe(t('reviewCard.emptyComplete'))
    expect(empty.className).not.toMatch(/\bbg-/)
    expect(screen.queryByTestId('review-repair')).toBeNull()
    expect(screen.getByTestId('review-rerun')).toBeTruthy()
    expect(screen.getByTestId('code-review-card').querySelector('footer')!.textContent).not.toContain(t('reviewCard.value.finished'))
  })
  it('names the repository: its remote name, else the change request project, else the directory', () => {
    const value = running()
    value.run.scope.workspaceKey = 'D:/work/my-dir'
    value.run.scope.repository = { projectKey: 'D:/work/my-dir', name: 'velloc-runtime' }
    value.targetLabel = 'D:/work/my-dir'
    renderReport(value)
    expect(screen.getByTestId('review-repository').textContent).toBe('velloc-runtime')
    // The project key standing in for a target adds nothing to the header.
    expect(screen.getByTestId('review-range').textContent).not.toContain('D:/work')
    cleanup()
    value.run.scope.repository = { projectKey: 'D:/work/my-dir' }
    renderReport(value)
    expect(screen.getByTestId('review-repository').textContent).toBe('my-dir')
    cleanup()
    value.run.scope.repository = { platform: 'github', projectKey: 'owner/repo' }
    renderReport(value)
    expect(screen.getByTestId('review-repository').textContent).toBe('repo')
  })
})
