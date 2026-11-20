/**
 * The theme switch in progress (F-25): a small panel in the window's
 * bottom-right corner, above everything, that lists the latest switch's steps
 * as the runtime reports them and then how it ended. It closes five seconds
 * after the end, or at its close button.
 */
import { CheckIcon, CircleIcon, Loader2Icon, PaletteIcon, XIcon } from 'lucide-react'
import * as React from 'react'

import { cn } from '@/lib/utils'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type {
  ThemeSwitchEntry,
  ThemeSwitchFailure,
  ThemeSwitchStep,
  ThemeSwitchStepState,
} from '../../../mods/themeSwitch'
import { useT, type TranslateFn } from '../i18n'
import type { MessageKey } from '../i18n/messages/en'
import { useThemeSwitches } from './themeSwitchView'

/** How long an ended switch stays on screen. */
export const THEME_SWITCH_CLOSE_MS = 5_000

const FAILURE: Record<ThemeSwitchFailure, MessageKey> = {
  unknownLook: 'customize.themes.reason.unknownLook',
  notLoaded: 'customize.themes.reason.notLoaded',
  notOwnCommand: 'customize.themes.reason.notOwnCommand',
  unanswered: 'customize.themes.reason.unanswered',
  commandFailed: 'customize.themes.reason.commandFailed',
  request: 'customize.themes.reason.request',
  cancelled: 'themeSwitch.cancelled',
}

function titleOf(entry: ThemeSwitchEntry, t: TranslateFn): string {
  const { subject } = entry
  switch (subject.kind) {
    case 'look':
      return t('themeSwitch.title.look', { name: subject.look })
    case 'enable':
      return t('themeSwitch.title.enable', { name: subject.plugin })
    case 'disable':
      return t('themeSwitch.title.disable', { name: subject.plugin })
    case 'turnOffAll':
      return t('themeSwitch.title.turnOffAll')
  }
}

function stepText(step: ThemeSwitchStep, t: TranslateFn): string {
  switch (step.kind) {
    case 'waitTurn':
      return t('themeSwitch.step.waitTurn')
    case 'turnOff':
      if (step.plugins.length > 0) return t('themeSwitch.step.turnOff', { names: step.plugins.join(', ') })
      return step.state === 'done' ? t('customize.themes.notice.noneOn') : t('themeSwitch.step.turnOffAny')
    case 'turnOn':
      return t('themeSwitch.step.turnOn', { name: step.plugin })
    case 'load':
      return t('themeSwitch.step.load', { name: step.plugin })
    case 'command':
      return t('themeSwitch.step.command', { command: step.command })
  }
}

function resultText(entry: ThemeSwitchEntry, t: TranslateFn): string | null {
  const { outcome, subject } = entry
  if (!outcome) return null
  if (!outcome.ok) return t(FAILURE[outcome.reason])
  switch (subject.kind) {
    case 'look':
      return t('themeSwitch.done.look', { name: subject.look })
    case 'enable':
      return t('themeSwitch.done.enable', { name: subject.plugin })
    case 'disable':
      return t('themeSwitch.done.disable', { name: subject.plugin })
    case 'turnOffAll':
      return t('customize.themes.notice.turnedOff')
  }
}

const StepMark: React.FC<{ state: ThemeSwitchStepState }> = ({ state }) => {
  if (state === 'running') return <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
  if (state === 'done') return <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
  return <XIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
}

/** The panel for one switch; `onClose` hides it. */
export const ThemeSwitchCard: React.FC<{ entry: ThemeSwitchEntry; onClose: () => void }> = ({ entry, onClose }) => {
  const t = useT()
  const result = resultText(entry, t)
  const failed = entry.outcome?.ok === false
  return (
    <div
      data-testid="theme-switch-panel"
      data-state={entry.outcome ? (failed ? 'failed' : 'done') : 'running'}
      role="status"
      aria-live="polite"
      aria-label={t('themeSwitch.region')}
      className="pointer-events-auto fixed end-4 bottom-4 z-[200] w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-3 text-popover-foreground text-sm shadow-lg"
    >
      <div className="flex items-center gap-2">
        <PaletteIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span data-testid="theme-switch-title" className="min-w-0 flex-1 truncate font-medium">
          {titleOf(entry, t)}
        </span>
        <button
          type="button"
          data-testid="theme-switch-close"
          aria-label={t('themeSwitch.close')}
          title={t('themeSwitch.close')}
          onClick={onClose}
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      </div>
      <ol data-testid="theme-switch-steps" className="mt-2 space-y-1">
        {entry.steps.map((step, index) => (
          <li
            key={index}
            data-testid={`theme-switch-step:${step.kind}`}
            data-state={step.state}
            className="flex items-center gap-2 text-xs"
          >
            <StepMark state={step.state} />
            <span
              className={cn('min-w-0 flex-1 break-words', step.state === 'running' ? 'text-foreground' : 'text-muted-foreground')}
            >
              {stepText(step, t)}
            </span>
          </li>
        ))}
        {!entry.outcome && entry.steps.length === 0 && (
          <li className="flex items-center gap-2 text-muted-foreground text-xs">
            <CircleIcon aria-hidden className="size-3.5 shrink-0" />
            <span>{t('themeSwitch.starting')}</span>
          </li>
        )}
      </ol>
      {result !== null && (
        <p
          data-testid="theme-switch-result"
          className={cn('mt-2 border-t pt-2 text-xs', failed ? 'text-destructive' : 'text-foreground')}
        >
          {result}
        </p>
      )}
    </div>
  )
}

/**
 * Which switch the panel shows: the latest one, unless closed. One that has
 * ended closes `closeMs` after this page saw it end.
 */
export function useShownThemeSwitch(
  switches: readonly ThemeSwitchEntry[] | undefined,
  closeMs = THEME_SWITCH_CLOSE_MS,
): { entry: ThemeSwitchEntry | null; close: () => void } {
  const latest = switches && switches.length > 0 ? switches[switches.length - 1]! : null
  const [closed, setClosed] = React.useState<ReadonlySet<string>>(() => new Set())
  const ended = latest?.outcome !== undefined
  const latestId = latest?.id
  React.useEffect(() => {
    if (!ended || latestId === undefined) return
    const timer = setTimeout(() => setClosed(previous => new Set(previous).add(latestId)), closeMs)
    return () => clearTimeout(timer)
  }, [ended, latestId, closeMs])
  const close = React.useCallback(() => {
    if (latestId !== undefined) setClosed(previous => new Set(previous).add(latestId))
  }, [latestId])
  return { entry: latest && !closed.has(latest.id) ? latest : null, close }
}

/** Mounted once per window: shows the runtime's latest theme switch. */
export const ThemeSwitchPanel: React.FC<{ runtimeConnection?: () => Promise<RuntimeConnection> }> = ({
  runtimeConnection,
}) => {
  const state = useThemeSwitches(runtimeConnection)
  const { entry, close } = useShownThemeSwitch(state?.switches)
  return entry ? <ThemeSwitchCard entry={entry} onClose={close} /> : null
}
