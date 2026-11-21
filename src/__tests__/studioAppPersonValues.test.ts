// @vitest-environment happy-dom
// A studio app surface hands the person's values back to the app once an event
// is sent (F-1): the app's later writes to those paths show, so a dialog it
// closes closes and a choice it changes changes.
import { afterEach, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { StudioAppSurface } from '../browser/webview/a2ui/studio/StudioAppSurface'
import type { AppSurfaceState } from '../browser/runtimeProtocol/modApps'
import type { StudioEvent } from '../browser/webview/a2ui/studio/StudioSurfaceHost'

afterEach(() => cleanup())

const BODY = [
  'surface("s")',
  'root = Column([pickRoute, dialog])',
  'pickRoute = ButtonGroup(value=$/data/route, options=$/data/routes, onChange=Event("select_route", {}))',
  'dialog = Modal(trigger=openButton, open=$/data/dialogOpen, content=inner, title="Dialog")',
  'inner = Column([innerPick, closeButton])',
  'innerPick = ButtonGroup(value=$/data/member, options=$/data/routes, onChange=Event("pick_member", {}))',
  'openButton = Button("Open dialog", onClick=Event("opened", {}))',
  'closeButton = Button("Done here", onClick=Event("done", {}))',
].join('\n')
const NOTE_BODY = [
  'surface("s")',
  'root = Column([note, pickRoute])',
  'note = TextField("Note", $/data/note)',
  'pickRoute = ButtonGroup(value=$/data/route, options=$/data/routes, onChange=Event("select_route", {}))',
].join('\n')
const routes = [{ value: 'a', label: 'Route A' }, { value: 'b', label: 'Route B' }, { value: 'c', label: 'Route C' }]
const board = (seq: number, data: Record<string, unknown>, body = BODY): AppSurfaceState => ({
  appId: 'x', catalog: 'studio', surface: { body, hash: 'h', surfaceIds: ['s'] },
  data: { routes, ...data }, dataSeq: seq, refreshing: false,
})
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text)
const on = (text: string) => button(text)?.getAttribute('data-state') === 'on'

it('after an event, the app sets the choice and closes the dialog', async () => {
  const events: StudioEvent[] = []
  const draw = (b: AppSurfaceState) => createElement(StudioAppSurface, { board: b, surfaceId: 's', onEvent: (e: StudioEvent) => events.push(e) })
  const view = render(draw(board(1, { route: 'a', dialogOpen: false })))
  await waitFor(() => expect(on('Route A')).toBe(true))
  fireEvent.click(button('Route B')!)
  await waitFor(() => expect(events.map(e => e.name)).toEqual(['select_route']))
  view.rerender(draw(board(2, { route: 'c', dialogOpen: false })))
  await waitFor(() => expect(on('Route C')).toBe(true))

  fireEvent.click(button('Open dialog')!)
  await waitFor(() => expect(button('Done here')).toBeDefined())
  // Its own trigger's event does not close it again.
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(button('Done here')).toBeDefined()
  fireEvent.click(button('Done here')!)
  await waitFor(() => expect(events.map(e => e.name)).toEqual(['select_route', 'opened', 'done']))
  // The app's value is still `false` and it writes nothing new: the dialog goes back to it.
  await waitFor(() => expect(button('Done here')).toBeUndefined())
})

it('a choice the person made stays until the app writes', async () => {
  const draw = (b: AppSurfaceState) => createElement(StudioAppSurface, { board: b, surfaceId: 's', onEvent: () => undefined })
  render(draw(board(1, { route: 'a', dialogOpen: false })))
  await waitFor(() => expect(on('Route A')).toBe(true))
  fireEvent.click(button('Route B')!)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(on('Route B')).toBe(true)
})

it('a choice inside an open dialog sends its event and leaves the dialog open', async () => {
  const events: StudioEvent[] = []
  const draw = (b: AppSurfaceState) => createElement(StudioAppSurface, { board: b, surfaceId: 's', onEvent: (e: StudioEvent) => events.push(e) })
  const view = render(draw(board(1, { route: 'a', member: 'a', dialogOpen: false })))
  fireEvent.click((await waitFor(() => button('Open dialog')!))!)
  await waitFor(() => expect(button('Done here')).toBeDefined())
  const inDialog = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent?.trim() === 'Route C') as HTMLElement
  fireEvent.click(inDialog)
  await waitFor(() => expect(events.map(e => e.name)).toContain('pick_member'))
  view.rerender(draw(board(2, { route: 'a', member: 'c', dialogOpen: false })))
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(button('Done here')).toBeDefined()
})

it('text the person typed survives another event and a data write that leaves its key alone', async () => {
  const draw = (b: AppSurfaceState) => createElement(StudioAppSurface, { board: b, surfaceId: 's', onEvent: () => undefined })
  const view = render(draw(board(1, { route: 'a', note: '' }, NOTE_BODY)))
  const input = await waitFor(() => document.querySelector('input')!)
  fireEvent.change(input, { target: { value: 'draft' } })
  fireEvent.click(button('Route B')!)
  view.rerender(draw(board(2, { route: 'b', note: '' }, NOTE_BODY)))
  await waitFor(() => expect(on('Route B')).toBe(true))
  expect(document.querySelector('input')!.value).toBe('draft')
  view.rerender(draw(board(3, { route: 'b', note: 'from app' }, NOTE_BODY)))
  await waitFor(() => expect(document.querySelector('input')!.value).toBe('from app'))
})
