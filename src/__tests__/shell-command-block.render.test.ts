// @vitest-environment happy-dom
/**
 * One-line shell blocks in chat messages (F-31): which fences become a Run
 * card, the card without a terminal to run in, and a Run that opens the
 * terminal on the run's tab and shows the run's output under the card as
 * its `terminal-run/<runId>` topic reports it.
 */
import { createElement, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'

import { TooltipProvider } from '../components/ui/tooltip'
import { MarkdownText } from '../components/assistant-ui/markdown-text'
import {
  ShellCommandContext,
  resetShellRunsForTests,
  runnableShellCommand,
  type ShellCommandContextValue,
} from '../components/assistant-ui/shell-command'
import type { RuntimeConnection, TopicEvent } from '../browser/runtimeClient/RuntimeConnection'
import type { TerminalRunState } from '../terminal/protocol'

afterEach(() => {
  cleanup()
  resetShellRunsForTests()
})

type Listener = (event: TopicEvent<unknown>) => void

function fakeConnection() {
  const listeners = new Map<string, Set<Listener>>()
  const conn = {
    subscribe: (topic: string, listener: Listener) => {
      let set = listeners.get(topic)
      if (!set) {
        set = new Set()
        listeners.set(topic, set)
      }
      set.add(listener)
      return () => set?.delete(listener)
    },
  } as unknown as RuntimeConnection
  const publish = (topic: string, payload: TerminalRunState, form: 'snapshot' | 'delta' = 'delta') => {
    act(() => {
      for (const listener of listeners.get(topic) ?? []) {
        listener({ topic, seq: 1, form, type: 'state', payload } as TopicEvent<unknown>)
      }
    })
  }
  return { conn, publish, subscribers: (topic: string) => listeners.get(topic)?.size ?? 0 }
}

function harness(text: string, value: ShellCommandContextValue): FC {
  const AssistantMessage: FC = () =>
    createElement(MessagePrimitive.Root, null, createElement(MessagePrimitive.Parts, { components: { Text: MarkdownText } }))
  const UserMessage: FC = () => null
  const message: ThreadMessageLike = { id: 'm1', role: 'assistant', content: [{ type: 'text', text }] }
  return function Harness() {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages: [message],
      convertMessage: m => m,
      isRunning: false,
      onNew: async () => {},
    })
    return createElement(
      TooltipProvider,
      null,
      createElement(
        ShellCommandContext.Provider,
        { value },
        createElement(
          AssistantRuntimeProvider,
          { runtime },
          createElement(
            ThreadPrimitive.Root,
            null,
            createElement(
              ThreadPrimitive.Viewport,
              null,
              createElement(ThreadPrimitive.Messages, { components: { AssistantMessage, UserMessage } }),
            ),
          ),
        ),
      ),
    )
  }
}

const runState = (over: Partial<TerminalRunState> = {}): TerminalRunState => ({
  terminalId: 'term_1',
  command: 'git status',
  status: 'running',
  output: '',
  truncated: false,
  ...over,
})

const flush = () => act(async () => {})

describe('runnableShellCommand', () => {
  it('takes one line, a trailing newline aside, and nothing with a control character', () => {
    expect(runnableShellCommand('git status\n')).toBe('git status')
    expect(runnableShellCommand('git status')).toBe('git status')
    expect(runnableShellCommand('cd src\nnpm test\n')).toBeNull()
    expect(runnableShellCommand('\n')).toBeNull()
    expect(runnableShellCommand('echo \u001b[31m')).toBeNull()
    expect(runnableShellCommand('echo \u202e hi')).toBeNull()
    expect(runnableShellCommand('echo \u2067x\u2069 hi')).toBeNull()
    expect(runnableShellCommand('rm\u200b -rf x')).toBeNull()
    expect(runnableShellCommand('ls\u2029rm -r x')).toBeNull()
    expect(runnableShellCommand('echo héllo')).toBe('echo héllo')
  })
})

describe('shell blocks in chat messages', () => {
  it('a one-line bash fence is a card with Run and Copy and no header row; a longer one stays a code block', () => {
    const run = vi.fn()
    render(createElement(harness('Try:\n\n```bash\ngit status\n```\n\nor\n\n```bash\ncd src\nnpm test\n```', { run, connection: null, sessionId: 's1' })))
    const cards = document.querySelectorAll('[data-shell-command]')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.querySelector('code')!.textContent).toBe('git status')
    expect(cards[0]!.querySelector('[data-shell-command-run]')).not.toBeNull()
    // Only the script keeps its language header.
    expect(document.querySelectorAll('.aui-code-header-root')).toHaveLength(1)
    expect(document.querySelector('pre > code')!.textContent).toContain('npm test')
  })

  it('a one-line block with a bidi override, an isolate or a zero-width character stays a code block without Run', () => {
    const run = vi.fn()
    const blocks = ['echo \u202e hi', 'echo \u2066x\u2069 hi', 'rm\u200b -rf x', 'ls\u2028rm -r x']
    const text = blocks.map(line => '```bash\n' + line + '\n```').join('\n\n')
    render(createElement(harness(text, { run, connection: null, sessionId: 's1' })))
    expect(document.querySelector('[data-shell-command]')).toBeNull()
    expect(document.querySelector('[data-shell-command-run]')).toBeNull()
    expect(document.querySelectorAll('pre > code')).toHaveLength(blocks.length)
  })

  it('without a terminal to run in, the card has Copy only', () => {
    render(createElement(harness('```pwsh\nGet-ChildItem\n```', { connection: null, sessionId: 's1' })))
    expect(document.querySelector('[data-shell-command]')).not.toBeNull()
    expect(document.querySelector('[data-shell-command-run]')).toBeNull()
  })

  it('Run opens the terminal on the run and shows its output under the card until the prompt is back', async () => {
    const fake = fakeConnection()
    const run = vi.fn(async () => ({ id: 'term_1', runId: 'run_1' }))
    const openTerminal = vi.fn()
    render(createElement(harness('```bash\ngit status\n```', { run, openTerminal, connection: fake.conn, sessionId: 's1' })))
    fireEvent.click(document.querySelector('[data-shell-command-run]')!)
    await flush()
    expect(run).toHaveBeenCalledWith('git status')
    expect(openTerminal).toHaveBeenCalledWith('term_1')
    expect(fake.subscribers('terminal-run/run_1')).toBe(1)
    expect(document.querySelector('[data-shell-command-output]')).toBeNull()

    fake.publish('terminal-run/run_1', runState({ output: 'On branch main' }), 'snapshot')
    const output = () => document.querySelector('[data-shell-command-output]')
    expect(output()!.getAttribute('data-shell-command-output')).toBe('running')
    expect(output()!.querySelector('pre')!.textContent).toBe('On branch main')

    fake.publish('terminal-run/run_1', runState({ status: 'done', output: 'On branch main\nnothing to commit' }))
    expect(output()!.getAttribute('data-shell-command-output')).toBe('done')
    expect(output()!.querySelector('pre')!.textContent).toBe('On branch main\nnothing to commit')

    // The terminal button in the output brings that terminal forward again.
    openTerminal.mockClear()
    fireEvent.click(output()!.querySelector('button')!)
    expect(openTerminal).toHaveBeenCalledWith('term_1')
  })

  it('two identical blocks in one message keep separate runs', async () => {
    const fake = fakeConnection()
    const run = vi.fn(async () => ({ id: 'term_1', runId: 'run_1' }))
    render(createElement(harness('```bash\ngit status\n```\n\nagain:\n\n```bash\ngit status\n```', { run, connection: fake.conn, sessionId: 's1' })))
    const cards = () => Array.from(document.querySelectorAll('[data-shell-command]'))
    expect(cards()).toHaveLength(2)
    fireEvent.click(cards()[1]!.querySelector('[data-shell-command-run]')!)
    await flush()
    fake.publish('terminal-run/run_1', runState({ output: 'On branch main' }), 'snapshot')
    expect(cards()[0]!.querySelector('[data-shell-command-output]')).toBeNull()
    expect(cards()[1]!.querySelector('[data-shell-command-output]')).not.toBeNull()
  })

  it('a run the runtime refuses says why under the card', async () => {
    const run = vi.fn(async () => {
      throw new Error('terminal.run: host_unavailable — no pseudoconsole')
    })
    render(createElement(harness('```bash\nls\n```', { run, connection: null, sessionId: 's1' })))
    fireEvent.click(document.querySelector('[data-shell-command-run]')!)
    await flush()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('no pseudoconsole')
    expect(document.querySelector('[data-shell-command-output]')).toBeNull()
  })
})
