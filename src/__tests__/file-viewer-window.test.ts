import { describe, expect, it, vi } from 'vitest'

import { createFileViewerWindow, type ViewerWebWindow } from '../browser/runtimeHub/fileViewerWindow'

function fakeWindows() {
  const open = new Set<number>()
  let next = 1
  const calls: string[] = []
  const windows: ViewerWebWindow = {
    open: vi.fn(async (url: string) => {
      const id = next++
      open.add(id)
      calls.push(`open ${url} -> ${id}`)
      return id
    }),
    navigate: vi.fn(async (id: number, url: string) => {
      calls.push(`navigate ${id} ${url}`)
    }),
    focus: vi.fn(async (id: number) => {
      calls.push(`focus ${id}`)
    }),
    list: vi.fn(async () => [...open].map(windowId => ({ windowId }))),
  }
  return { windows, calls, close: (id: number) => open.delete(id) }
}

describe('createFileViewerWindow', () => {
  it('opens one window, then loads the next file in it and brings it forward', async () => {
    const fake = fakeWindows()
    const show = createFileViewerWindow(() => fake.windows)
    await show('file:///a.mp4')
    await show('file:///b.pdf')
    expect(fake.calls).toEqual(['open file:///a.mp4 -> 1', 'navigate 1 file:///b.pdf', 'focus 1'])
  })

  it('opens a new window once the person closed the last one', async () => {
    const fake = fakeWindows()
    const show = createFileViewerWindow(() => fake.windows)
    await show('file:///a.mp4')
    fake.close(1)
    await show('file:///b.mp4')
    expect(fake.calls).toEqual(['open file:///a.mp4 -> 1', 'open file:///b.mp4 -> 2'])
  })

  it('runs two quick opens one after the other, so they share one window', async () => {
    const fake = fakeWindows()
    const show = createFileViewerWindow(() => fake.windows)
    await Promise.all([show('file:///a.mp4'), show('file:///b.mp4')])
    expect(fake.windows.open).toHaveBeenCalledTimes(1)
    expect(fake.calls.at(-2)).toBe('navigate 1 file:///b.mp4')
  })

  it('rejects with no host windows, and a failed open does not block the next', async () => {
    let windows: ViewerWebWindow | null = null
    const show = createFileViewerWindow(() => windows)
    await expect(show('file:///a.mp4')).rejects.toThrow()
    windows = fakeWindows().windows
    await expect(show('file:///a.mp4')).resolves.toBeUndefined()
  })
})
