/**
 * `metadata.custom` key the adapter stamps on the live assistant message once
 * the turn has ended (the client is no longer `submitting`). The live half
 * stays on screen, still `running`, until the transcript refetch replaces it
 * (the composer must not read idle before the reply is there), so this is the
 * only signal that streamed text may stop animating and show whole.
 */
export const TURN_SETTLED_KEY = 'turnSettled'
