// @vitest-environment happy-dom
// A studio Modal closes on a backdrop click unless it says closeOnBackdrop=false;
// Escape still closes it either way.
import { afterEach, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { StudioAppSurface } from '../browser/webview/a2ui/studio/StudioAppSurface'
import type { AppSurfaceState } from '../browser/runtimeProtocol/modApps'

afterEach(() => cleanup())

const body = (extra: string) => [
  'surface("s")',
  'root = Column([dialog])',
  `dialog = Modal(trigger=openButton, content=inner, title="Dialog"${extra})`,
  'inner = Text("Inside")',
  'openButton = Button("Open dialog")',
].join('\n')
const board = (b: string): AppSurfaceState => ({
  appId: 'x', catalog: 'studio', surface: { body: b, hash: 'h', surfaceIds: ['s'] },
  data: {}, dataSeq: 1, refreshing: false,
})
const open = async (extra: string) => {
  render(createElement(StudioAppSurface, { board: board(body(extra)), surfaceId: 's', onEvent: () => {} }))
  const trigger = await waitFor(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent?.trim() === 'Open dialog')
    expect(b).toBeTruthy()
    return b!
  })
  fireEvent.click(trigger)
  return waitFor(() => {
    const backdrop = document.querySelector('[data-a2ui-modal-backdrop]')
    expect(backdrop).toBeTruthy()
    return backdrop as HTMLElement
  })
}

it('closes on a backdrop click by default', async () => {
  fireEvent.click(await open(''))
  await waitFor(() => expect(document.querySelector('[data-a2ui-modal-backdrop]')).toBeNull())
})

it('stays open on a backdrop click with closeOnBackdrop=false, and Escape still closes it', async () => {
  fireEvent.click(await open(', closeOnBackdrop=false'))
  expect(document.querySelector('[data-a2ui-modal-backdrop]')).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(document.querySelector('[data-a2ui-modal-backdrop]')).toBeNull())
})
