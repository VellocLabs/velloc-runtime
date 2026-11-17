/**
 * An app drawn as one plugin page (F-42), loaded only through `import()`.
 *
 * Security: the page runs in `<iframe sandbox="allow-scripts" srcdoc>`, so its
 * origin is opaque and it reaches neither this document nor storage. Its only
 * line to the runtime is a port capped to `observe` on the topics the host
 * allows (`openObserverPort`); closing the pane ends that connection.
 */

import { useEffect, useRef, useState } from 'react'
import type { ModsAppPageResult } from '../../runtimeProtocol/modApps'
import { openObserverPort } from '../../runtimeClient/observerPorts'
import { useT } from '../i18n'
import { APP_PAGE_PORT_MESSAGE, relayAppPagePort, type AppPageRelay } from './appPageRelay'

export type AppPageFrameProps = {
  /** `mods.appPage` for this app; undefined when there is no connection. */
  readPage(): Promise<ModsAppPageResult | undefined>
}

export function AppPageFrame({ readPage }: AppPageFrameProps) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const frameTitle = t('apps.pageFrame')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let live = true
    let frame: HTMLIFrameElement | null = null
    let relay: AppPageRelay | null = null
    void readPage()
      .then(result => {
        if (!live) return
        if (!result?.ok) {
          setFailed(true)
          return
        }
        const created = document.createElement('iframe')
        created.setAttribute('sandbox', 'allow-scripts')
        created.setAttribute('data-slot', 'app-page-frame')
        created.title = frameTitle
        created.className = 'h-full w-full border-0'
        created.srcdoc = result.html
        created.addEventListener('load', () => {
          if (!live || relay || !created.contentWindow) return
          const runtimePort = openObserverPort(result.topics)
          if (!runtimePort) {
            setFailed(true)
            return
          }
          relay = relayAppPagePort(runtimePort)
          created.contentWindow.postMessage({ kind: APP_PAGE_PORT_MESSAGE }, '*', [relay.pagePort])
        })
        frame = created
        host.appendChild(created)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
      relay?.close()
      frame?.remove()
    }
  }, [readPage, frameTitle])

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
