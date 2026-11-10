import type { Message } from '../../runtime/RuntimeTypes'

/**
 * Puts the physical transcript line back on each message, looked up by uuid in THIS session's
 * conversation store (never the process-global slot, which may belong to another session).
 */
export async function withTranscriptLines(
  messages: readonly Message[],
  store: unknown,
): Promise<Message[]> {
  const lines =
    store && typeof store === 'object' && 'getTranscriptLinesByUuid' in store
      ? await (
          store as {
            getTranscriptLinesByUuid(): Promise<Record<string, number>>
          }
        ).getTranscriptLinesByUuid()
      : {}
  return messages.map(message => {
    const uuid = (message as { uuid?: string }).uuid
    const line = uuid === undefined ? undefined : lines[uuid]
    return line === undefined
      ? message
      : ({ ...message, transcriptLine: line } as Message)
  })
}
