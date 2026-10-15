import type { Message, StreamRecord } from '../../runtime/RuntimeTypes'

export type WebviewMessageListProps = {
  transcriptMessages: Message[]
  liveEvents: StreamRecord[]
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => formatValue(item)).join('\n')
  }

  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>

    if (typeof record.text === 'string') {
      return record.text
    }

    if (typeof record.message === 'string') {
      return record.message
    }

    if (Array.isArray(record.content)) {
      return record.content.map(item => formatValue(item)).join('\n')
    }

    return JSON.stringify(record, null, 2)
  }

  return String(value)
}

function getMessageBody(message: Message | StreamRecord): string {
  if ('message' in message) {
    return formatValue(message.message)
  }

  if ('result' in message) {
    return formatValue(message.result)
  }

  if ('errors' in message) {
    return formatValue(message.errors)
  }

  return formatValue(message)
}

function getMessageKey(
  message: Message | StreamRecord,
  index: number,
  prefix: string,
): string {
  return `${prefix}-${message.uuid ?? index}`
}

export function WebviewMessageList({
  transcriptMessages,
  liveEvents,
}: WebviewMessageListProps) {
  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        minHeight: 220,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        background: 'var(--card)',
        color: 'var(--card-foreground)',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Conversation</div>
      {transcriptMessages.length === 0 ? (
        <div style={{ color: 'var(--muted-foreground)' }}>No persisted messages yet.</div>
      ) : (
        transcriptMessages.map((message, index) => (
          <article
            key={getMessageKey(message, index, 'transcript')}
            style={{
              padding: '8px 0',
              borderTop: index === 0 ? 'none' : '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 4 }}>
              {message.type}
            </div>
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {getMessageBody(message)}
            </pre>
          </article>
        ))
      )}

      <div style={{ fontWeight: 700, marginTop: 16, marginBottom: 8 }}>
        Live Turn
      </div>
      {liveEvents.length === 0 ? (
        <div style={{ color: 'var(--muted-foreground)' }}>No live runtime events.</div>
      ) : (
        liveEvents.map((event, index) => (
          <article
            key={getMessageKey(event, index, 'live')}
            style={{
              padding: '8px 0',
              borderTop: index === 0 ? 'none' : '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--success)', marginBottom: 4 }}>
              {event.type}
            </div>
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {getMessageBody(event)}
            </pre>
          </article>
        ))
      )}
    </section>
  )
}
