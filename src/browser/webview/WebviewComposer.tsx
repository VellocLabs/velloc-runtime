import type { FormEvent } from 'react'

export type WebviewComposerProps = {
  value: string
  disabled?: boolean
  statusText?: string
  onChange: (value: string) => void
  onSubmit: () => void | Promise<void>
}

export function WebviewComposer({
  value,
  disabled = false,
  statusText,
  onChange,
  onSubmit,
}: WebviewComposerProps) {
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!value.trim()) {
      return
    }
    await onSubmit()
  }

  const sendDisabled = disabled || !value.trim()
  return (
    <form
      onSubmit={handleSubmit}
      style={{
        display: 'grid',
        gap: 8,
      }}
    >
      <textarea
        value={value}
        disabled={disabled}
        onChange={event => {
          onChange(event.target.value)
        }}
        placeholder="Send a browser-runtime prompt"
        rows={5}
        style={{
          width: '100%',
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--background)',
          color: 'var(--foreground)',
          padding: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          resize: 'vertical',
        }}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div style={{ color: 'var(--muted-foreground)', fontSize: 13 }}>
          {statusText ?? 'Ready'}
        </div>
        <button
          type="submit"
          disabled={sendDisabled}
          style={{
            border: '1px solid var(--primary)',
            background: sendDisabled ? 'var(--muted)' : 'var(--primary)',
            color: sendDisabled
              ? 'var(--muted-foreground)'
              : 'var(--primary-foreground)',
            borderRadius: 999,
            padding: '8px 16px',
            cursor: sendDisabled ? 'not-allowed' : 'pointer',
          }}
        >
          Send
        </button>
      </div>
    </form>
  )
}
