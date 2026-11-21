// @vitest-environment happy-dom
/**
 * An app that names the studio catalog (F-1, F-40), page half: the pane draws
 * the board with the studio engine, extends one operation list on each change,
 * and a press takes the path every app surface's press takes.
 */
import { createElement as h } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import { A2uiProviderHost } from '../browser/webview/a2ui/A2uiProviderHost'
import { setActionsSlot, setOwner, setShownSession, setSlot } from '../browser/webview/a2ui/a2uiPaneBus'
import { studioAppOperations } from '../browser/webview/a2ui/studio/StudioAppSurface'
import { setModContributions } from '../browser/webview/mods/modContributionsView'
import { EMPTY_MOD_CONTRIBUTIONS } from '../browser/runtimeProtocol/modContributions'
import type { AppSurfaceState, ModsAppActionResult } from '../browser/runtimeProtocol/modApps'
import {
  DASHBOARD_EXPRESS,
  DASHBOARD_START,
  DASHBOARD_SURFACE_ID,
  dashboardData,
  dashboardStep,
  type DashboardState,
} from '../browser/webview/a2ui/studio/dev/dashboardFixture'

afterEach(() => {
  cleanup()
  setSlot(null, null)
  setActionsSlot(null)
  setOwner(null)
  setShownSession(null)
  act(() => setModContributions(EMPTY_MOD_CONTRIBUTIONS))
})

const board = (state: DashboardState, localActions?: string[]): AppSurfaceState => ({
  appId: 'pay-board',
  catalog: 'studio',
  surface: { body: DASHBOARD_EXPRESS, hash: 'h1', surfaceIds: [DASHBOARD_SURFACE_ID] },
  data: dashboardData(state),
  text: { title: 'Router' },
  refreshing: false,
  ...(localActions ? { localActions } : {}),
})

function rig(state: AppSurfaceState, answer?: () => Promise<ModsAppActionResult | undefined>) {
  const slot = document.createElement('div')
  document.body.appendChild(slot)
  setSlot(slot, 's1')
  const submit = vi.fn(async (_prompt: string) => undefined)
  const actFn = vi.fn<(action: string, context: unknown) => Promise<ModsAppActionResult | undefined>>(answer ?? (async () => ({ handled: true })))
  const element = (next: AppSurfaceState) =>
    h(A2uiProviderHost, {
      sessionId: 's1',
      messages: [],
      busy: false,
      submitActionMessage: submit,
      appBoard: { state: next, reload: async () => undefined, act: actFn },
      children: null,
    })
  const view = render(element(state))
  const button = (text: string) => [...slot.querySelectorAll('button')].find(el => el.textContent?.includes(text))
  const drawn = async (text: string) => waitFor(() => expect(slot.textContent).toContain(text), { timeout: 10_000 })
  return { slot, submit, actFn, button, drawn, show: (next: AppSurfaceState) => view.rerender(element(next)) }
}

describe('the operations a studio surface is drawn from', () => {
  it('are the whole list: the build, then the text, then the data', () => {
    const operations = studioAppOperations(board(DASHBOARD_START), DASHBOARD_SURFACE_ID) as Array<Record<string, { path?: string; value?: unknown }>>
    expect(Object.keys(operations[0]!)).toContain('createSurface')
    expect(operations.at(-2)?.updateDataModel).toMatchObject({ path: '/text', value: { title: 'Router' } })
    expect(operations.at(-1)?.updateDataModel).toMatchObject({ path: '/data', value: dashboardData(DASHBOARD_START) })
  })

  it('are none for a surface the build does not draw, or a body that does not compile', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(studioAppOperations(board(DASHBOARD_START), 'other')).toEqual([])
    const broken = { ...board(DASHBOARD_START), surface: { body: 'surface("x")\nroot = NoSuchComponent("a")', hash: 'h2', surfaceIds: ['x'] } }
    expect(studioAppOperations(broken, 'x')).toEqual([])
    warn.mockRestore()
  })
})

describe('a studio app in the pane', () => {
  it('is drawn by the studio engine and redrawn when the board\'s data changes', async () => {
    const { slot, drawn, show } = rig(board(DASHBOARD_START))
    await drawn('系统运行正常')
    expect(slot.querySelector('[data-slot="a2ui-studio-surface"]')).not.toBeNull()
    expect(slot.querySelector(`[data-slot="a2ui-surface"][data-surface-id="${DASHBOARD_SURFACE_ID}"]`)).not.toBeNull()
    show(board(dashboardStep(DASHBOARD_START, 'refresh_status', undefined)))
    await drawn('系统运行正常 · 1')
  })

  it('a local action goes to the app\'s module and not to the model', async () => {
    const { submit, actFn, button, drawn } = rig(board(DASHBOARD_START, ['refresh_status']))
    await drawn('刷新状态')
    fireEvent.click(button('刷新状态')!)
    await waitFor(() => expect(actFn).toHaveBeenCalledTimes(1))
    expect(actFn.mock.calls[0]![0]).toBe('refresh_status')
    await act(async () => undefined)
    expect(submit).not.toHaveBeenCalled()
  })

  it('any other press goes to the model as a turn with the action, the surface and the board\'s data', async () => {
    const { submit, actFn, button, drawn } = rig(board(DASHBOARD_START))
    await drawn('刷新状态')
    fireEvent.click(button('刷新状态')!)
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(actFn).not.toHaveBeenCalled()
    const turn = submit.mock.calls[0]![0] as unknown as string
    expect(turn).toContain('"action":"refresh_status"')
    expect(turn).toContain(`"surfaceId":"${DASHBOARD_SURFACE_ID}"`)
    expect(turn).toContain('"sourceComponentId":"refresh_btn"')
    expect(turn).toContain('"text":{"title":"Router"}')
    expect(turn).toContain('"data":{')
  })

  it('a local action the module declines goes to the model', async () => {
    const { submit, button, drawn } = rig(board(DASHBOARD_START, ['refresh_status']), async () => ({ handled: false }))
    await drawn('刷新状态')
    fireEvent.click(button('刷新状态')!)
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  })
})
