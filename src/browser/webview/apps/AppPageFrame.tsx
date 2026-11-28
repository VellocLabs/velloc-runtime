/**
 * An app drawn as one plugin page (F-42), loaded only through `import()`.
 *
 * Security: `<iframe sandbox="allow-scripts" srcdoc>` under `APP_PAGE_CSP` (in
 * the page and as the frame's `csp`): an opaque origin with no network. Its one
 * line to the runtime is an `observe` port on the host's topics, handed to the
 * first document only; another document loading, or the pane closing, ends it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ModsAppPageResult } from '../../runtimeProtocol/modApps'
import { openObserverPort } from '../../runtimeClient/observerPorts'
import { A2uiPaneSkeleton } from '../a2ui/A2uiPaneSkeleton'
import { useT } from '../i18n'
import { APP_PAGE_CSP, withAppPageCsp } from './appPageCsp'
import { APP_PAGE_PORT_MESSAGE, relayAppPagePort, type AppPageRelay } from './appPageRelay'
import { appPageHiddenReleaseMs, watchAppPage } from './appPageWatch'

/**
 * Security: the host keys its block on this name, read when the frame is added
 * (so it is set before): no navigation away from about:srcdoc, no WebRTC
 * socket, no network hint. It must match the host's name (F-42).
 */
export const APP_PAGE_FRAME_NAME = 'velloc-app-page'

export type AppPageFrameProps = {
  /** `mods.appPage` for this app; undefined when there is no connection. */
  readPage(): Promise<ModsAppPageResult | undefined>
}

/**
 * Contract: the host element's `data-state`. `stopped`: the page left its
 * pings unanswered; `failed`: no page or no port; `released`: hidden past
 * `appPageHiddenReleaseMs`, rebuilt when shown. A stopped or failed page
 * comes back only through Retry.
 */
type Phase = 'loading' | 'running' | 'stopped' | 'failed' | 'released'
type Problem = 'stopped' | 'failed'

export function AppPageFrame({ readPage }: AppPageFrameProps) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [problem, setProblem] = useState<Problem | null>(null)
  // Each value is one frame; a new value builds a new frame (Retry, or a show
  // after a release).
  const [build, setBuild] = useState(0)
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
    let endWatch: (() => void) | null = null
    let releaseTimer: ReturnType<typeof setTimeout> | undefined
    let loads = 0
    const teardown = () => {
      live = false
      clearTimeout(releaseTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      endWatch?.()
      endWatch = null
      relay?.close()
      relay = null
      frame?.remove()
      frame = null
      frameRef.current = null
    }
    const end = (next: Problem | 'released') => {
      if (!live) return
      teardown()
      setPhase(next)
      setProblem(next === 'released' ? null : next)
    }
    function onVisibility() {
      clearTimeout(releaseTimer)
      if (document.visibilityState === 'hidden') {
        releaseTimer = setTimeout(() => end('released'), appPageHiddenReleaseMs())
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
    setPhase('loading')
    void readPage()
      .then(result => {
        if (!live) return
        if (!result?.ok) {
          end('failed')
          return
        }
        const created = document.createElement('iframe')
        created.setAttribute('sandbox', 'allow-scripts')
        created.setAttribute('csp', APP_PAGE_CSP)
        created.setAttribute('data-slot', 'app-page-frame')
        created.name = APP_PAGE_FRAME_NAME
        created.title = titleRef.current
        created.className = 'h-full w-full border-0'
        created.srcdoc = withAppPageCsp(result.html)
        created.addEventListener('load', () => {
          if (!live || frame !== created) return
          loads += 1
          const page = created.contentWindow
          if (loads > 1 || !page) {
            end('failed')
            return
          }
          const runtimePort = openObserverPort(result.topics)
          if (!runtimePort) {
            end('failed')
            return
          }
          relay = relayAppPagePort(runtimePort)
          page.postMessage({ kind: APP_PAGE_PORT_MESSAGE }, '*', [relay.pagePort])
          endWatch = watchAppPage(page, () => end('stopped'))
          setProblem(null)
          setPhase('running')
        })
        frame = created
        frameRef.current = created
        host.appendChild(created)
      })
      .catch(() => end('failed'))
    return teardown
  }, [readPage, build])

  useEffect(() => {
    if (phase !== 'released') return
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setBuild(n => n + 1)
    }
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [phase])

  const retry = useCallback(() => setBuild(n => n + 1), [])

  return (
    <div ref={hostRef} data-slot="app-page" data-state={phase} className="relative h-full min-h-0 w-full">
      {problem ? (
        <div className="flex flex-col items-start gap-2 p-3">
          <p role="alert" className="text-sm text-muted-foreground">
            {t(problem === 'stopped' ? 'apps.pageStopped' : 'apps.pageFailed')}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="app-page-retry"
            disabled={phase === 'loading'}
            onClick={retry}
          >
            {t('apps.pageRetry')}
          </Button>
        </div>
      ) : phase === 'released' || phase === 'loading' ? (
        <A2uiPaneSkeleton />
      ) : null}
    </div>
  )
}
