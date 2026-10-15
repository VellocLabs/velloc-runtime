// @vitest-environment happy-dom
/**
 * The sidebar's restart notice: shown only while an installed update waits
 * for a restart, only to a connection allowed to relaunch; its button asks
 * `appUpdate.relaunch`. Driven by a fake connection.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { RuntimeConnection } from '../../browser/runtimeClient/RuntimeConnection'
import { AppUpdateBar } from '../../browser/webview/AppUpdateBar'
import { RuntimeCapabilitiesContext } from '../../browser/webview/useCan'
import { APP_UPDATE_STATUS_TOPIC, type AppUpdateState } from '../../appUpdate/appUpdateProtocol'
import { queryFor } from '../_helpers/capabilityQuery'

afterEach(cleanup)

function rig(initial: AppUpdateState, onRelaunch?: () => Promise<unknown>) {
  const requests: Array<{ route: string; payload: unknown }> = []
  let push: (s: AppUpdateState) => void = () => {}
  const conn = {
    subscribe: (topic: string, listener: (event: { payload: unknown }) => void) => {
      if (topic === APP_UPDATE_STATUS_TOPIC) {
        push = s => listener({ payload: s })
        queueMicrotask(() => push(initial))
      }
      return () => {}
    },
    request: async (route: string, payload: unknown) => {
      requests.push({ route, payload })
      return onRelaunch ? onRelaunch() : { ok: true }
    },
  } as unknown as RuntimeConnection
  return { requests, connection: () => Promise.resolve(conn), push: (s: AppUpdateState) => act(() => push(s)) }
}

function show(r: ReturnType<typeof rig>, variant: 'bar' | 'rail' = 'bar', acts: string[] = ['relaunch']) {
  render(
    createElement(
      RuntimeCapabilitiesContext.Provider,
      { value: queryFor(acts.length ? [{ cap: 'appUpdate', acts }] : []) },
      createElement(AppUpdateBar, { runtimeConnection: r.connection, variant }),
    ),
  )
}

const READY: AppUpdateState = { available: true, phase: 'ready', current: '1.149.2.4', target: '1.149.2.5' }

describe('AppUpdateBar', () => {
  it('stays hidden while checking, downloading or installing, and appears once ready', async () => {
    const r = rig({ available: true, phase: 'downloading', target: '1.149.2.5' })
    show(r)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByTestId('app-update-bar')).toBeNull()
    r.push({ available: true, phase: 'installing', target: '1.149.2.5' })
    expect(screen.queryByTestId('app-update-bar')).toBeNull()
    r.push(READY)
    await waitFor(() => expect(screen.getByTestId('app-update-bar')).toBeTruthy())
    expect(screen.getByTestId('app-update-bar').textContent).toContain('1.149.2.5 is ready')
    expect(screen.getByTestId('app-update-restart').textContent).toBe('Restart to update')
  })

  it('the button asks appUpdate.relaunch with no payload', async () => {
    const r = rig(READY)
    show(r)
    fireEvent.click(await screen.findByTestId('app-update-restart'))
    await waitFor(() => expect(r.requests).toEqual([{ route: 'appUpdate.relaunch', payload: {} }]))
    expect(screen.getByTestId('app-update-restart').textContent).toBe('Restarting...')
  })

  it('a refused restart says so and lets the person try again', async () => {
    const r = rig(READY, () => Promise.reject(new Error('conflict')))
    show(r)
    fireEvent.click(await screen.findByTestId('app-update-restart'))
    await waitFor(() => expect(screen.getByTestId('app-update-bar').textContent).toContain('Could not restart.'))
    expect((screen.getByTestId('app-update-restart') as HTMLButtonElement).disabled).toBe(false)
  })

  it('is not offered to a connection that may not relaunch the host', async () => {
    const r = rig(READY)
    show(r, 'bar', [])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByTestId('app-update-bar')).toBeNull()
  })

  it('the collapsed rail shows an icon button that relaunches', async () => {
    const r = rig(READY)
    show(r, 'rail')
    const button = await screen.findByTestId('app-update-rail')
    expect(button.getAttribute('aria-label')).toBe('Restart to update to 1.149.2.5')
    fireEvent.click(button)
    await waitFor(() => expect(r.requests).toHaveLength(1))
  })
})
