import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { AppendMessage } from '@assistant-ui/react'
import type { ComposerDelivery } from '../../components/assistant-ui/inject-message-context'
import type { AgentRuntimeWorkerSnapshot } from '../worker/workerProtocol'
import type { SubmitDelivery } from './BrowserRuntimeClient'
import { resolveForkSendPlan } from './forkSend'
import { composerSendText, createPassageDraftStore, passageAsQuoted, serializePassagePrompt } from './capturedPassages'
import { extractTextFromAppendMessage } from './assistantUiAdapter'
import { engageConversationLockToBottom } from './conversationScrollLock'
import { resolveComposerSendGateOnceCatalogLoads } from './composerSendGate'
import type { AssistantUiThreadProps } from './AssistantUiThreadProps'

/** The composer's quote-card store and its `onNew` submit handler: the send gate, fork sends and delivery. */
export function useComposerSubmit({
  state,
  readOnly,
  activeSessionId,
  submitPrompt,
  submitComposerMessage,
  onSendInForkedSession,
  onAdoptDefaultSelection,
  snapshotRef,
  waitForSnapshot,
  runtimeBusyRef,
  lockToBottomRef,
  nextDeliveryRef,
  findViewport,
  setProviderPrompt,
  setRestoreComposerText,
}: {
  state: AssistantUiThreadProps['state']
  readOnly: boolean
  activeSessionId: AssistantUiThreadProps['activeSessionId']
  submitPrompt: AssistantUiThreadProps['submitPrompt']
  submitComposerMessage: AssistantUiThreadProps['submitComposerMessage']
  onSendInForkedSession: AssistantUiThreadProps['onSendInForkedSession']
  onAdoptDefaultSelection: AssistantUiThreadProps['onAdoptDefaultSelection']
  snapshotRef: RefObject<AgentRuntimeWorkerSnapshot | null>
  waitForSnapshot: (ms: number) => Promise<void>
  runtimeBusyRef: RefObject<boolean>
  lockToBottomRef: RefObject<boolean>
  nextDeliveryRef: RefObject<ComposerDelivery | undefined>
  findViewport: () => HTMLElement | null
  setProviderPrompt: Dispatch<SetStateAction<string | null>>
  setRestoreComposerText: Dispatch<SetStateAction<string | null>>
}) {

  // The composer's quote cards; one store per mounted thread (threads are
  // keyed by session).
  const [passageStore] = useState(() => createPassageDraftStore())

  const onNew = useCallback(
    async (rawMessage: AppendMessage) => {
      const delivery = nextDeliveryRef.current
      nextDeliveryRef.current = undefined
      if (readOnly) return
      // The cards leave the composer with its own send, like its text; every
      // path below that hands the text back hands them back too.
      const takenPassages = passageStore.takeForSend(composerSendText(rawMessage.content))
      const message: AppendMessage =
        takenPassages.length === 0
          ? rawMessage
          : {
              ...rawMessage,
              metadata: {
                ...rawMessage.metadata,
                custom: {
                  ...rawMessage.metadata?.custom,
                  passages: takenPassages.map(passageAsQuoted),
                },
              },
            }
      const handBack = (text: string) => {
        passageStore.restore(takenPassages)
        setRestoreComposerText(text)
      }
      const decision = await resolveComposerSendGateOnceCatalogLoads({
        readSnapshot: () => snapshotRef.current,
        waitForSnapshot,
        activeSessionId,
        canAdoptDefault: onAdoptDefaultSelection != null,
      })
      if (decision.kind !== 'send') {
        // `composer.send()` has ALREADY cleared the composer by the time we
        // run, so EVERY refusal has to hand the text back or the user's draft
        // is silently destroyed. Restoring here — once, for every non-send
        // outcome — is what makes that structural instead of something each
        // new branch has to remember. (`provider-missing` is the exception:
        // its dialog owns the restore and puts the text back on close, so
        // restoring here too would clobber anything typed while it was open.)
        if (decision.kind === 'provider-missing') {
          passageStore.restore(takenPassages)
          setProviderPrompt(extractTextFromAppendMessage(message))
          return
        }
        handBack(extractTextFromAppendMessage(message))
        if (decision.kind === 'adopt-default') {
          onAdoptDefaultSelection?.(decision.selection)
        }
        return
      }

      // Ctrl/Cmd+Alt+Enter: the message goes into a forked copy of this
      // session, not into this one. Nothing to fork (an empty session) → it
      // is an ordinary send (`inject` is ignored while idle) — unless the
      // first turn is still running, when it would land in THAT turn
      // (`resolveForkSendPlan`): hand the text back instead.
      if (delivery === 'fork') {
        const plan = resolveForkSendPlan(
          state.transcriptMessages,
          runtimeBusyRef.current,
        )
        if (plan.kind === 'refuse') {
          handBack(extractTextFromAppendMessage(message))
          return
        }
        if (plan.kind === 'fork' && onSendInForkedSession) {
          const forked = await onSendInForkedSession(plan.cutUuid, message)
          if (!forked) {
            handBack(extractTextFromAppendMessage(message))
          }
          return
        }
      }
      const submitDelivery: SubmitDelivery | undefined =
        delivery === 'fork' ? 'inject' : delivery

      engageConversationLockToBottom(lockToBottomRef, findViewport())
      if (submitComposerMessage) {
        try {
          await submitComposerMessage(
            message,
            submitDelivery ? { delivery: submitDelivery } : undefined,
          )
        } catch (error) {
          // Never accepted: the cards go back to the composer.
          passageStore.restore(takenPassages)
          throw error
        }
        return
      }

      const prompt = serializePassagePrompt(
        takenPassages.map(passageAsQuoted),
        extractTextFromAppendMessage(message),
      ).trim()
      if (!prompt) return
      await submitPrompt(prompt)
    },
    [
      passageStore,
      submitComposerMessage,
      submitPrompt,
      onAdoptDefaultSelection,
      activeSessionId,
      onSendInForkedSession,
      state.transcriptMessages,
      waitForSnapshot,
    ],
  )

  return { passageStore, onNew }
}
