/**
 * An app drawn as one plugin page (F-42), loaded only through `import()`.
 *
 * Security: the page runs in `<iframe sandbox="allow-scripts" srcdoc>`, so its
 * origin is opaque and it reaches neither this document nor storage, under a
 * policy that refuses network requests: in the page (`withAppPageCsp`) and
 * required of every document the frame loads (`csp`), so a remote document it
 * navigates to is refused. Its only line to the
 * runtime is a port capped to `observe` on the topics the host allows
 * (`openObserverPort`), handed to the first document only: when the frame
 * loads another document, or the pane closes, that connection ends.
 */

import { useEffect, useRef, useState } from 'react'
import type { ModsAppPageResult } from '../../runtimeProtocol/modApps'
import { openObserverPort } from '../../runtimeClient/observerPorts'
import { useT } from '../i18n'
import { APP_PAGE_CSP, withAppPageCsp } from './appPageCsp'
import { APP_PAGE_PORT_MESSAGE, relayAppPagePort, type AppPageRelay } from './appPageRelay'

export type AppPageFrameProps = {
  /** `mods.appPage` for this app; undefined when there is no connection. */
  readPage(): Promise<ModsAppPageResult | undefined>
}

export function AppPageFrame({ readPage }: AppPageFrameProps) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [failed, setFailed] = useState(false)
  const frameTitle = t('apps.pageFrame')
  const titleRef = useRef(frameTitle)
  titleRef.current = frameTitle

  useEffect(() => {
    if (frameRef.current) frameRef.current.title = frameTitle
  }, [frameTitle])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let live = true
    let frame: HTMLIFrameElement | null = null
    let relay: AppPageRelay | null = null
    let loads = 0
    const fail = () => {
      relay?.close()
      frame?.remove()
      frame = null
      frameRef.current = null
      setFailed(true)
    }
    setFailed(false)
    void readPage()
      .then(result => {
        if (!live) return
        if (!result?.ok) {
          setFailed(true)
          return
        }
        const created = document.createElement('iframe')
        created.setAttribute('sandbox', 'allow-scripts')
        created.setAttribute('csp', APP_PAGE_CSP)
        created.setAttribute('data-slot', 'app-page-frame')
        created.title = titleRef.current
        created.className = 'h-full w-full border-0'
        created.srcdoc = withAppPageCsp(result.html)
        created.addEventListener('load', () => {
          if (!live || frame !== created) return
          loads += 1
          if (loads > 1) {
            fail()
            return
          }
          const runtimePort = created.contentWindow ? openObserverPort(result.topics) : null
          if (!runtimePort) {
            fail()
            return
          }
          relay = relayAppPagePort(runtimePort)
          created.contentWindow!.postMessage({ kind: APP_PAGE_PORT_MESSAGE }, '*', [relay.pagePort])
        })
        frame = created
        frameRef.current = created
        host.appendChild(created)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
      relay?.close()
      frame?.remove()
      frameRef.current = null
    }
  }, [readPage])

  return (
    <div ref={hostRef} data-slot="app-page" className="relative h-full min-h-0 w-full">
      {failed ? (
        <p role="alert" className="p-3 text-sm text-muted-foreground">
          {t('apps.pageFailed')}
        </p>
      ) : null}
    </div>
  )
}
