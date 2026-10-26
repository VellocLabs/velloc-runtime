import * as React from 'react'
import { Loader2Icon } from 'lucide-react'

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

import { parseMarketplaceSource } from '../../../pluginHost/marketplaceSource'
import type { PluginsBridgeActionMap } from '../../bridge/protocol/plugins'
import { useT } from '../i18n'

export type AddMarketplaceResult = PluginsBridgeActionMap['addMarketplace']['result']

export type AddMarketplaceDialogProps = {
  open: boolean
  /** Adds the typed source; a rejected promise is shown as a failed add. */
  onAdd: (source: string) => Promise<AddMarketplaceResult>
  /** The marketplace that was added, or the one already holding the repository. */
  onShow: (name: string) => void
  onClose: () => void
}

type AddState =
  | { step: 'editing'; invalid: boolean }
  | { step: 'adding' }
  | { step: 'already'; name: string }
  | { step: 'failed'; reason: 'fetch' | 'save'; error: string }

const EDITING: AddState = { step: 'editing', invalid: false }

/**
 * Adds a marketplace by its GitHub repository (F-35): the text is checked as
 * it is typed, the add downloads the marketplace's plugin list, and the
 * dialog closes onto the new marketplace's section. A repository that is
 * already added, or one that cannot be read, is said plainly.
 */
export function AddMarketplaceDialog({ open, onAdd, onShow, onClose }: AddMarketplaceDialogProps) {
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
  React.useEffect(() => {
    if (open) {
      setText('')
      setState(EDITING)
    }
  }, [open])

  const adding = state.step === 'adding'
  const parsed = parseMarketplaceSource(text)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (adding) return
    if (!parsed) {
      setState({ step: 'editing', invalid: true })
      return
    }
    setState({ step: 'adding' })
    let result: AddMarketplaceResult
    try {
      result = await onAdd(text.trim())
    } catch (error) {
      if (live.current) setState({ step: 'failed', reason: 'save', error: messageOf(error) })
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
        setState({ step: 'failed', reason: result.stage === 'fetch' ? 'fetch' : 'save', error: result.error })
    }
  }

  const invalid = state.step === 'editing' && state.invalid
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next && !adding) onClose()
      }}
    >
      <DialogContent data-testid="customize-add-market-dialog" className="sm:max-w-md">
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{t('customize.addMarket.title')}</DialogTitle>
            <DialogDescription>{t('customize.addMarket.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="customize-add-market-source" className="text-sm font-medium text-foreground">
              {t('customize.addMarket.label')}
            </label>
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
              onChange={event => {
                setText(event.target.value)
                if (state.step !== 'adding') setState(EDITING)
              }}
            />
            <p
              id="customize-add-market-hint"
              data-testid="customize-add-market-hint"
              role={invalid ? 'alert' : undefined}
              className={invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
            >
              {t(invalid ? 'customize.addMarket.invalid' : 'customize.addMarket.hint')}
            </p>
          </div>
          {adding ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              {t('customize.addMarket.adding')}
            </p>
          ) : null}
          {state.step === 'already' ? (
            <div role="status" data-testid="customize-add-market-already" className="flex items-center gap-3">
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
              </Button>
            </div>
          ) : null}
          {state.step === 'failed' ? (
            <div role="alert" data-testid="customize-add-market-failed" className="flex flex-col gap-1">
              <p className="text-sm text-destructive">
                {t(state.reason === 'fetch' ? 'customize.addMarket.fetchFailed' : 'customize.addMarket.saveFailed')}
              </p>
              {state.error ? (
                <p className="break-words font-mono text-xs text-muted-foreground">{state.error}</p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
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
              {adding ? <Loader2Icon className="size-4 animate-spin" /> : null}
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
            {error ? <p className="break-words font-mono text-xs text-muted-foreground">{error}</p> : null}
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

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return typeof error === 'string' ? error : ''
}
