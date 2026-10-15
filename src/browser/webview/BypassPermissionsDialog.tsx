import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useT } from './i18n'

/**
 * Bypass-Permissions warning dialog (F-13): confirms the switch into `bypassPermissions`
 * before it is applied; declining leaves the mode unchanged. Suppressed once
 * `skipDangerousModePermissionPrompt` is accepted.
 */

/**
 * Decide whether switching the permission mode must be gated behind the
 * warning dialog. Pure, so the load-bearing logic is unit-tested without React.
 *
 * Gate iff the target is `bypassPermissions`, we are NOT already in it, AND the
 * user has not previously accepted the warning. Other modes never gate;
 * re-selecting bypass while already in bypass never re-prompts.
 */
export function shouldGateBypassSwitch(params: {
  next: string
  current: string
  skipFlag: boolean
}): boolean {
  return (
    params.next === 'bypassPermissions' &&
    params.current !== 'bypassPermissions' &&
    params.skipFlag !== true
  )
}

export function BypassPermissionsDialog({
  open,
  onAccept,
  onCancel,
}: {
  /** Whether the warning is showing (a switch-to-bypass is pending). */
  open: boolean
  /** Persist the acknowledgment + apply bypass + close. */
  onAccept: () => void
  /** Do NOT apply bypass (the mode was never changed) + close. Also fires on
   *  the X button, Escape, and overlay click — Escape dismisses without
   *  accepting, and the prior mode stays. */
  onCancel: () => void
}) {
  const t = useT()
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) onCancel()
      }}
    >
      <DialogContent data-testid="bypass-dialog" className="border-destructive/50">
        <DialogHeader>
          <DialogTitle className="text-destructive">
            {t('bypassDialog.title')}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {t('bypassDialog.body')}
          </DialogDescription>
        </DialogHeader>
        <a
          href={t('bypassDialog.docsUrl')}
          target="_blank"
          rel="noreferrer"
          className="text-sm underline underline-offset-2"
        >
          {t('bypassDialog.learnMore')}
        </a>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t('bypassDialog.decline')}
          </Button>
          <Button variant="destructive" onClick={onAccept}>
            {t('bypassDialog.accept')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
