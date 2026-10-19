import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { GlobeIcon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useT } from '../i18n'
import type { SessionTabEntry } from '../../bridge/protocol/session'

/** The new-tab page: the field shows it as empty, ready for an address. */
const BLANK_TAB_URLS = new Set(['chrome://newtab/', 'chrome://new-tab-page/', 'about:blank'])

/** The URL the address field shows for a tab: blank pages show nothing. */
export function displayAddress(url: string | undefined): string {
  if (!url || BLANK_TAB_URLS.has(url)) return ''
  return url
}

/** A tab's strip label: its title, else its host, else the caller's fallback. */
export function tabLabel(tab: Pick<SessionTabEntry, 'title' | 'url'>, fallback: string): string {
  const title = tab.title.trim()
  if (title) return title
  const shown = displayAddress(tab.url)
  if (!shown) return fallback
  try {
    return new URL(shown).host || shown
  } catch {
    return shown
  }
}

export type BrowserTabStripProps = {
  tabs: readonly SessionTabEntry[]
  onActivate: (tabId: number) => void
  onClose: (tabId: number) => void
}

/**
 * The browser pane's tab strip (F-9): the session's tabs in this window, in
 * strip order, the active one marked. Lives in the pane's title slot.
 */
export function BrowserTabStrip({ tabs, onActivate, onClose }: BrowserTabStripProps): ReactElement {
  const t = useT()
  const fallback = t('pane.browser.newTab')
  return (
    <div
      role="tablist"
      data-testid="pane-browser-tabs"
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
    >
      {tabs.map(tab => {
        const label = tabLabel(tab, fallback)
        return (
          <div
            key={tab.id}
            data-testid={`pane-browser-tab:${tab.id}`}
            data-active={tab.active ? 'true' : undefined}
            className={cn(
              'group flex min-w-0 items-center gap-0.5 rounded-md py-0.5 pe-0.5 ps-1.5 text-[12px]',
              tab.active ? 'bg-muted' : 'hover:bg-muted/50',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.active}
              data-testid={`pane-browser-tab-activate:${tab.id}`}
              title={displayAddress(tab.url) || label}
              onClick={() => onActivate(tab.id)}
              className={cn(
                'flex min-w-0 max-w-[12rem] items-center gap-1 outline-none',
                tab.active ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              <GlobeIcon aria-hidden className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{label}</span>
            </button>
            <button
              type="button"
              aria-label={t('pane.browser.closeTab', { title: label })}
              data-testid={`pane-browser-tab-close:${tab.id}`}
              onClick={() => onClose(tab.id)}
              className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export type BrowserAddressBarProps = {
  /** The active tab, whose address the field shows; none disables the field. */
  tab: SessionTabEntry | null
  onNavigate: (tabId: number, text: string) => void
}

/**
 * The browser pane's address field (F-9): shows the active tab's URL and
 * follows it while the field is not being edited; Enter sends the text to
 * the host, which decides between an address and a search. Escape restores
 * the tab's URL.
 */
export function BrowserAddressBar({ tab, onNavigate }: BrowserAddressBarProps): ReactElement {
  const t = useT()
  const shown = displayAddress(tab?.url)
  const [draft, setDraft] = useState(shown)
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const tabId = tab?.id ?? null

  // The field follows the tab (a navigation, a tab switch) unless the person
  // is typing in it; a tab switch always resets, typed or not.
  const lastTabIdRef = useRef(tabId)
  useEffect(() => {
    const switched = lastTabIdRef.current !== tabId
    lastTabIdRef.current = tabId
    if (switched || !editing) setDraft(shown)
    if (switched) setEditing(false)
  }, [tabId, shown, editing])

  const submit = () => {
    if (tabId === null) return
    const text = draft.trim()
    if (!text) return
    onNavigate(tabId, text)
    setEditing(false)
    inputRef.current?.blur()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDraft(shown)
      setEditing(false)
      inputRef.current?.blur()
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-1.5 py-1">
      <input
        ref={inputRef}
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        data-testid="pane-browser-address"
        aria-label={t('pane.browser.address')}
        placeholder={t('pane.browser.addressPlaceholder')}
        disabled={tabId === null}
        value={draft}
        onChange={event => {
          setEditing(true)
          setDraft(event.target.value)
        }}
        onFocus={event => event.currentTarget.select()}
        onBlur={() => {
          // Leaving the field drops an unsent edit: the tab's URL is the truth.
          setEditing(false)
          setDraft(shown)
        }}
        onKeyDown={onKeyDown}
        className={cn(
          'h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-[12px] outline-none',
          'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/40',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      />
    </div>
  )
}
