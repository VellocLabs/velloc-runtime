import * as React from 'react'
import { describe, expect, it } from 'vitest'

import {
  releaseConnectScreenRoot,
  renderConnectScreen,
} from '@/browser/boot/remoteBoot'

type ReactDomClient = typeof import('react-dom/client')

/**
 * The connect screen shows the latest requested state whatever order the renders' module loads settle in; here the
 * `connecting` render's react-dom is held until the failure render has painted.
 */
describe('remote connect screen: render order', () => {
  function fakeReactDom(painted: string[]): ReactDomClient {
    const createRoot = (() => ({
      render: (element: React.ReactElement<{ children: React.ReactElement<{ state: string }> }>) => {
        painted.push(element.props.children.props.state)
      },
      unmount: () => {},
    })) as unknown as ReactDomClient['createRoot']
    return { createRoot } as ReactDomClient
  }

  it('a failure requested after `connecting` wins even when `connecting` loads last', async () => {
    releaseConnectScreenRoot()
    const painted: string[] = []
    const reactDom = fakeReactDom(painted)
    const container = {} as HTMLElement

    let releaseConnecting!: (value: ReactDomClient) => void
    const connecting = renderConnectScreen(
      container,
      {
        reactPromise: Promise.resolve(React),
        reactDomPromise: new Promise<ReactDomClient>(resolve => {
          releaseConnecting = resolve
        }),
      },
      undefined,
      { state: 'connecting' },
    )
    await renderConnectScreen(
      container,
      { reactPromise: Promise.resolve(React), reactDomPromise: Promise.resolve(reactDom) },
      undefined,
      { state: 'unauthorized' },
    )
    releaseConnecting(reactDom)
    await connecting

    expect(painted).toEqual(['unauthorized'])
  })

  it('a render still loading when the root is released paints nothing', async () => {
    releaseConnectScreenRoot()
    const painted: string[] = []
    let release!: (value: ReactDomClient) => void
    const pending = renderConnectScreen(
      {} as HTMLElement,
      {
        reactPromise: Promise.resolve(React),
        reactDomPromise: new Promise<ReactDomClient>(resolve => {
          release = resolve
        }),
      },
      undefined,
      { state: 'connecting' },
    )
    // The shell is taking the container.
    releaseConnectScreenRoot()
    release(fakeReactDom(painted))
    await pending

    expect(painted).toEqual([])
  })
})
