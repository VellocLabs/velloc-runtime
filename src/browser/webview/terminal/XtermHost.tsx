/**
 * One xterm.js emulator bound to one `terminal/<id>` topic (F-31): the
 * snapshot replays the scrollback (the emulator's answers to queries in it
 * are not sent), deltas stream output, keystrokes go back
 * as `terminal.write` once per frame, and the host element's size drives
 * `terminal.resize`. Also the find bar (Ctrl+Shift+F). Loaded lazily: this
 * module carries the xterm chunk.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

import { Button } from '@/components/ui/button'
import type { RuntimeConnection } from '@/browser/runtimeClient/RuntimeConnection'
import { topic } from '@/browser/runtimeProtocol'
import { TERMINAL_CAPABILITY, isTerminalSize } from '@/terminal/protocol'
import { readClipboard, writeClipboard } from '@/utils/clipboard'

import { useT } from '../i18n'
import { FitScheduler } from './terminalFit'
import { terminalKeyDecision } from './terminalKeys'
import type { TerminalPrefs } from './terminalPrefs'
import { registerTerminalProbe } from './terminalProbe'
import { applyTerminalTopicEvent, InputBatcher, ReplayGate, type MirroredTerminal } from './xtermBinding'
import {
  buildTerminalTheme,
  documentScheme,
  resolveCssToken,
  resolveMonoFont,
  watchDocumentScheme,
} from './xtermTheme'

export type XtermHostProps = {
  terminalId: string
  connection: RuntimeConnection
  prefs: TerminalPrefs
  /** Take keyboard focus once the emulator is open. */
  autoFocus?: boolean
  /** A web link clicked in the output. */
  openLink: (url: string) => void
}

const FIT_DEBOUNCE_MS = 100
const FONT_SIZE_PX = 13

/**
 * Security: input is sent only to the terminal id this host was given, and
 * only through the runtime's `terminal.write` action.
 */
export function XtermHost({ terminalId, connection, prefs, autoFocus, openLink }: XtermHostProps): ReactElement {
  const t = useT()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const fitterRef = useRef<FitScheduler | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const openLinkRef = useRef(openLink)
  openLinkRef.current = openLink
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  const openFind = useCallback(() => {
    setFindOpen(true)
    queueMicrotask(() => findInputRef.current?.focus())
  }, [])

  const closeFind = useCallback(() => {
    setFindOpen(false)
    setQuery('')
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      allowProposedApi: true,
      cursorStyle: prefsRef.current.cursorStyle,
      cursorBlink: prefsRef.current.cursorBlink,
      scrollback: prefsRef.current.scrollbackLines,
      fontFamily: resolveMonoFont(),
      fontSize: FONT_SIZE_PX,
      theme: buildTerminalTheme(documentScheme(), resolveCssToken),
    })
    termRef.current = term
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    searchRef.current = searchAddon
    term.loadAddon(new Unicode11Addon())
    term.loadAddon(fitAddon)
    term.loadAddon(searchAddon)
    term.loadAddon(new WebLinksAddon((_event, uri) => openLinkRef.current(uri)))
    term.unicode.activeVersion = '11'
    term.open(host)
    // WebGL when the platform gives us a context; the DOM renderer otherwise
    // and after a context loss.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // No WebGL: the DOM renderer draws.
    }

    const request = (act: string, payload: unknown): void => {
      void connection.request(`${TERMINAL_CAPABILITY}.${act}`, payload).catch(() => {
        // The terminal may have gone; the topic's state delta says so.
      })
    }
    const input = new InputBatcher(data => request('write', { id: terminalId, data }))
    const replay = new ReplayGate()
    let mirror: MirroredTerminal | null = null
    let lastSent: { cols: number; rows: number } | null = null

    const sendSize = (cols: number, rows: number): void => {
      if (!isTerminalSize(cols, rows)) return
      if (lastSent && lastSent.cols === cols && lastSent.rows === rows) return
      lastSent = { cols, rows }
      request('resize', { id: terminalId, cols, rows })
    }
    const fit = (): void => {
      const dims = fitAddon.proposeDimensions()
      // A hidden host measures 0×0 (NaN): nothing to apply, nothing to send.
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
      if (dims.cols < 2 || dims.rows < 1) return
      if (dims.cols !== term.cols || dims.rows !== term.rows) term.resize(dims.cols, dims.rows)
      sendSize(term.cols, term.rows)
    }
    const fitter = new FitScheduler({
      measure: () => ({ width: host.clientWidth, height: host.clientHeight }),
      fit,
      debounceMs: FIT_DEBOUNCE_MS,
    })
    fitterRef.current = fitter
    const hasFocus = (): boolean => host.contains(document.activeElement)

    const unsubscribe = connection.subscribe(topic.terminal(terminalId), event => {
      const next = applyTerminalTopicEvent(term, mirror, event, replay)
      if (event.form === 'snapshot') {
        mirror = next
        // Our own size wins while this view is focused; the first snapshot
        // adopts the console's size until the host has measured itself.
        fitter.fitNow()
        return
      }
      if (event.type === 'resize' && next && next !== mirror) {
        mirror = next
        if (hasFocus()) {
          lastSent = null
          fitter.fitNow()
        } else if (next.cols !== term.cols || next.rows !== term.rows) {
          term.resize(next.cols, next.rows)
        }
        return
      }
      mirror = next
    })

    const dataDisposable = term.onData(data => {
      if (replay.admits(data)) input.push(data)
    })
    const selectionDisposable = term.onSelectionChange(() => {
      if (prefsRef.current.copyOnSelect && term.hasSelection()) {
        void writeClipboard(term.getSelection())
      }
    })
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true
      switch (terminalKeyDecision(event, { hasSelection: term.hasSelection() })) {
        case 'app':
          return false
        case 'copy':
          if (term.hasSelection()) {
            void writeClipboard(term.getSelection())
            term.clearSelection()
          }
          event.preventDefault()
          return false
        case 'paste':
          event.preventDefault()
          void readClipboard().then(text => {
            if (text) term.paste(text)
          })
          return false
        case 'search':
          event.preventDefault()
          openFind()
          return false
        case 'shell':
          return true
      }
    })

    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitter.observed()) : null
    observer?.observe(host)
    const releaseTheme = watchDocumentScheme(scheme => {
      term.options.theme = buildTerminalTheme(scheme, resolveCssToken)
    })

    fitter.fitNow()
    if (autoFocus) term.focus()
    const releaseProbe = registerTerminalProbe(terminalId, {
      lines: () => {
        const buffer = term.buffer.active
        const lines: string[] = []
        for (let i = 0; i < buffer.length; i++) {
          lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
        }
        while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
        return lines
      },
      cols: () => term.cols,
      rows: () => term.rows,
      input: data => term.input(data, true),
    })

    return () => {
      releaseProbe()
      fitterRef.current = null
      fitter.dispose()
      observer?.disconnect()
      releaseTheme()
      unsubscribe()
      dataDisposable.dispose()
      selectionDisposable.dispose()
      input.dispose()
      searchRef.current = null
      termRef.current = null
      term.dispose()
    }
    // The emulator is rebuilt for another terminal or connection only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, connection])

  // The observer reports a new box only when the window renders, and a
  // covered window does not; a render of this host still happens, so the
  // box is checked here against the last one fitted.
  useLayoutEffect(() => {
    fitterRef.current?.rendered()
  })

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.cursorStyle = prefs.cursorStyle
    term.options.cursorBlink = prefs.cursorBlink
    term.options.scrollback = prefs.scrollbackLines
  }, [prefs.cursorStyle, prefs.cursorBlink, prefs.scrollbackLines])

  useEffect(() => {
    if (!findOpen) return
    const search = searchRef.current
    if (!search) return
    if (query) search.findNext(query, { incremental: true })
    else search.clearDecorations()
  }, [findOpen, query])

  const onFindKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeFind()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (!query) return
      if (event.shiftKey) searchRef.current?.findPrevious(query)
      else searchRef.current?.findNext(query)
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid={`terminal-host-${terminalId}`}>
      {findOpen ? (
        <div
          data-testid="terminal-find"
          className="absolute end-3 top-2 z-10 flex items-center gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <input
            ref={findInputRef}
            data-testid="terminal-find-input"
            className="h-7 w-44 rounded-sm bg-transparent px-2 text-body outline-none"
            placeholder={t('terminal.findPlaceholder')}
            aria-label={t('terminal.find')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onFindKey}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('terminal.findPrevious')}
            onClick={() => query && searchRef.current?.findPrevious(query)}
          >
            <ChevronUpIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('terminal.findNext')}
            onClick={() => query && searchRef.current?.findNext(query)}
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="terminal-find-close"
            aria-label={t('terminal.findClose')}
            onClick={closeFind}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden bg-card ps-2 pt-1" />
    </div>
  )
}

export default XtermHost
