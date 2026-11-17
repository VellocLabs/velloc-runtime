import * as React from 'react'
import {
  ArrowRightIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  FileJsonIcon,
  FolderGit2Icon,
  InfoIcon,
  Loader2Icon,
  PlusIcon,
  StoreIcon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { parseMarketplaceSource } from '../../../pluginHost/marketplaceSource'
import type { PluginsBridgeActionMap } from '../../bridge/protocol/plugins'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n/messages/en'

export type AddMarketplaceResult = PluginsBridgeActionMap['addMarketplace']['result']

export type AddMarketplaceDialogProps = {
  open: boolean
  /** Adds the typed source; a rejected promise is shown as a failed add. */
  onAdd: (source: string) => Promise<AddMarketplaceResult>
  /** The marketplace that was added, or the one already holding the repository. */
  onShow: (name: string) => void
  onClose: () => void
  /** A source to add as the dialog opens, as if typed and Add pressed; a new `seq` adds again. */
  request?: { source: string; seq: number } | null
}

type AddState =
  | { step: 'editing'; invalid: boolean }
  | { step: 'adding' }
  | { step: 'already'; name: string }
  | { step: 'failed'; reason: FailedReason; name: string; error: string }

type FailedReason = 'fetch' | 'save' | 'nameTaken' | 'nameRefused'

const FAILED_HEADLINE = {
  fetch: 'customize.addMarket.fetchFailed',
  save: 'customize.addMarket.saveFailed',
  nameTaken: 'customize.addMarket.nameTaken',
  nameRefused: 'customize.addMarket.nameRefused',
} as const satisfies Record<FailedReason, MessageKey>

/** The failure an add's result names; a registry write failure is a save failure. */
function failedReasonOf(stage: Extract<AddMarketplaceResult, { status: 'failed' }>['stage']): FailedReason {
  return stage === 'register' || stage === 'rename' ? 'save' : stage
}

const EDITING: AddState = { step: 'editing', invalid: false }

/**
 * Adds a marketplace by its GitHub repository (F-35): the text is checked as
 * it is typed, the add reads only the marketplace's plugin list (each plugin
 * is downloaded when it is added), and the dialog closes onto the new
 * marketplace's section. A repository that is already added, or one that
 * cannot be read, is said plainly.
 */
export function AddMarketplaceDialog({ open, onAdd, onShow, onClose, request }: AddMarketplaceDialogProps) {
  const t = useT()
  const [text, setText] = React.useState('')
  const [state, setState] = React.useState<AddState>(EDITING)
  const live = React.useRef(true)
  React.useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const adding = state.step === 'adding'
  const parsed = parseMarketplaceSource(text)

  const add = async (value: string) => {
    if (!parseMarketplaceSource(value)) {
      setState({ step: 'editing', invalid: true })
      return
    }
    setState({ step: 'adding' })
    let result: AddMarketplaceResult
    try {
      result = await onAdd(value.trim())
    } catch (error) {
      if (live.current) setState({ step: 'failed', reason: 'save', name: '', error: messageOf(error) })
      return
    }
    if (!live.current) return
    switch (result.status) {
      case 'added':
        onShow(result.name)
        onClose()
        return
      case 'alreadyAdded':
        setState({ step: 'already', name: result.name })
        return
      case 'invalidSource':
        setState({ step: 'editing', invalid: true })
        return
      case 'failed':
        setState({ step: 'failed', reason: failedReasonOf(result.stage), name: result.name, error: result.error })
    }
  }
  const addRef = React.useRef(add)
  addRef.current = add

  const requestRef = React.useRef(request)
  requestRef.current = request
  const requestSeq = request?.seq
  // A new open, or a new request while open, starts over.
  React.useEffect(() => {
    if (!open) return
    const source = requestRef.current?.source ?? ''
    setText(source)
    setState(EDITING)
    if (source) void addRef.current(source)
  }, [open, requestSeq])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!adding) void add(text)
  }

  const invalid = state.step === 'editing' && state.invalid
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next && !adding) onClose()
      }}
    >
      <DialogContent data-testid="customize-add-market-dialog" className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <form className="flex flex-col" onSubmit={submit} noValidate>
          <DialogHeader className="flex-row items-start gap-3.5 space-y-0 border-b bg-muted/30 px-6 pt-6 pb-5 text-left">
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-background text-primary shadow-xs"
            >
              <StoreIcon className="size-5" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle>{t('customize.addMarket.title')}</DialogTitle>
              <DialogDescription>{t('customize.addMarket.description')}</DialogDescription>
            </div>
          </DialogHeader>

          <div className="flex flex-col gap-4 px-6 py-5">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="customize-add-market-source" className="text-sm font-medium text-foreground">
                {t('customize.addMarket.label')}
              </label>
              <div className="relative">
                <FolderGit2Icon
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="customize-add-market-source"
                  data-testid="customize-add-market-input"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  value={text}
                  disabled={adding}
                  placeholder={t('customize.addMarket.placeholder')}
                  aria-invalid={invalid || undefined}
                  aria-describedby="customize-add-market-hint"
                  className="h-10 pl-9 font-mono"
                  onChange={event => {
                    setText(event.target.value)
                    if (state.step !== 'adding') setState(EDITING)
                  }}
                />
                {parsed && !invalid && !adding ? (
                  <CheckIcon
                    aria-hidden
                    data-testid="customize-add-market-valid"
                    className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-primary"
                  />
                ) : null}
              </div>
              <p
                id="customize-add-market-hint"
                data-testid="customize-add-market-hint"
                role={invalid ? 'alert' : undefined}
                className={cn(
                  'flex items-start gap-1.5 text-xs',
                  invalid ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {invalid ? (
                  <CircleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
                ) : (
                  <InfoIcon aria-hidden className="mt-px size-3.5 shrink-0" />
                )}
                {t(invalid ? 'customize.addMarket.invalid' : 'customize.addMarket.hint')}
              </p>
            </div>

            <div
              data-testid="customize-add-market-manifest-note"
              className="flex items-start gap-2.5 rounded-lg border border-dashed px-3 py-2.5"
            >
              <FileJsonIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs leading-relaxed text-muted-foreground">{t('customize.addMarket.manifestOnly')}</p>
            </div>

            {adding ? (
              <p
                role="status"
                className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground"
              >
                <Loader2Icon aria-hidden className="size-4 shrink-0 animate-spin" />
                {t('customize.addMarket.adding')}
              </p>
            ) : null}
            {state.step === 'already' ? (
              <div
                role="status"
                data-testid="customize-add-market-already"
                className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2.5"
              >
                <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-primary" />
                <p className="min-w-0 flex-1 text-sm text-foreground">
                  {t('customize.addMarket.already', { name: state.name })}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="customize-add-market-show"
                  onClick={() => {
                    onShow(state.name)
                    onClose()
                  }}
                >
                  {t('customize.addMarket.show')}
                  <ArrowRightIcon aria-hidden className="size-3.5" />
                </Button>
              </div>
            ) : null}
            {state.step === 'failed' ? (
              <div
                role="alert"
                data-testid="customize-add-market-failed"
                className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5"
              >
                <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-sm text-destructive">{t(FAILED_HEADLINE[state.reason], { name: state.name })}</p>
                  {(state.reason === 'fetch' || state.reason === 'save') && state.error ? (
                    <ErrorDetail detail={state.error} />
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <DialogFooter className="border-t bg-muted/20 px-6 py-4">
            <Button
              type="button"
              variant="outline"
              data-testid="customize-add-market-cancel"
              disabled={adding}
              onClick={onClose}
            >
              {t('customize.addMarket.cancel')}
            </Button>
            <Button type="submit" data-testid="customize-add-market-confirm" disabled={adding || !text.trim()}>
              {adding ? <Loader2Icon aria-hidden className="size-4 animate-spin" /> : <PlusIcon aria-hidden className="size-4" />}
              {t(adding ? 'customize.addMarket.confirming' : 'customize.addMarket.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export type RemoveMarketplaceDialogProps = {
  /** The marketplace to remove; null closes the dialog. */
  name: string | null
  onRemove: (name: string) => Promise<void>
  onClose: () => void
}

/**
 * Confirms removing a marketplace (F-35) and says what it does: its plugins
 * leave this list, and plugins already installed from it stay but stop
 * getting updates.
 */
export function RemoveMarketplaceDialog({ name, onRemove, onClose }: RemoveMarketplaceDialogProps) {
  const t = useT()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const shown = React.useRef(name)
  if (name !== null) shown.current = name
  React.useEffect(() => {
    setBusy(false)
    setError(null)
  }, [name])

  const remove = async () => {
    if (name === null || busy) return
    setBusy(true)
    setError(null)
    try {
      await onRemove(name)
      onClose()
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={name !== null}
      onOpenChange={next => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent data-testid="customize-remove-market-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('customize.removeMarket.title', { name: shown.current ?? '' })}</DialogTitle>
          <DialogDescription>{t('customize.removeMarket.description')}</DialogDescription>
        </DialogHeader>
        {error !== null ? (
          <div role="alert" className="flex flex-col gap-1">
            <p className="text-sm text-destructive">{t('customize.removeMarket.failed')}</p>
            {error ? <ErrorDetail detail={error} /> : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t('customize.addMarket.cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            data-testid="customize-remove-market-confirm"
            disabled={busy}
            onClick={remove}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {t('customize.removeMarket.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The untranslated technical reason of a failure nothing more specific explains, labelled as such. */
function ErrorDetail({ detail }: { detail: string }) {
  const t = useT()
  return (
    <p data-testid="customize-market-error-detail" className="break-words font-mono text-xs text-muted-foreground">
      {t('customize.market.errorDetail', { detail })}
    </p>
  )
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return typeof error === 'string' ? error : ''
}
