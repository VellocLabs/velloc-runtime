import { describe, expect, it, vi } from 'vitest'
import { builtinCommands, commandFor, type CommandContext } from '../engine/builtinCommands'
import type { ProcessUserInputResult } from '../runtime/interfaces/UserInputPipeline'

/** The built-in command table: which processed inputs name an entry, and
 *  what the entries that need no model do to the session. */

function processed(fields: Partial<ProcessUserInputResult> & { action?: string }): ProcessUserInputResult {
  return { messages: [], shouldQuery: false, ...fields } as ProcessUserInputResult
}

async function run(generator: AsyncGenerator<unknown, void, unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const row of generator) out.push(row)
  return out
}

describe('builtin command table', () => {
  it('has one entry per built-in action', () => {
    expect(Object.keys(builtinCommands).sort()).toEqual(['clear', 'compact', 'open-settings', 'reload-plugins', 'rename'])
  })

  it('resolves an action to its entry and nothing else', () => {
    expect(commandFor(processed({ action: 'clear' }))).toBe(builtinCommands.clear)
    expect(commandFor(processed({ action: 'rename' }))).toBe(builtinCommands.rename)
    expect(commandFor(processed({}))).toBeUndefined()
    expect(commandFor(processed({ action: 'no-such-action' } as never))).toBeUndefined()
    // Names an object inherits are not entries.
    expect(commandFor(processed({ action: 'toString' } as never))).toBeUndefined()
  })

  it('/rename stores the title, cancels the background attempt and yields nothing', async () => {
    const storeUserTitle = vi.fn(async () => undefined)
    const cancel = vi.fn()
    const ctx = {
      ledger: { config: { conversationStore: { storeUserTitle } } },
      titler: { cancel },
      result: processed({ action: 'rename', renameTitle: 'Chosen name' } as never),
    } as unknown as CommandContext
    expect(await run(builtinCommands.rename(ctx))).toEqual([])
    expect(storeUserTitle).toHaveBeenCalledWith('Chosen name', 'user')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('/rename without a title does nothing', async () => {
    const cancel = vi.fn()
    const ctx = { ledger: { config: {} }, titler: { cancel }, result: processed({ action: 'rename' }) } as unknown as CommandContext
    expect(await run(builtinCommands.rename(ctx))).toEqual([])
    expect(cancel).not.toHaveBeenCalled()
  })

  it('/mcp opens the requested settings section, models by default', async () => {
    const onOpenSettings = vi.fn(async () => undefined)
    const ledger = { config: { onOpenSettings } }
    await run(builtinCommands['open-settings']({ ledger, result: processed({ action: 'open-settings' }) } as unknown as CommandContext))
    await run(
      builtinCommands['open-settings']({ ledger, result: processed({ action: 'open-settings', settingsSection: 'mcp' } as never) } as unknown as CommandContext),
    )
    expect(onOpenSettings.mock.calls).toEqual([['models'], ['mcp']])
  })

  it('/plugins hands the new enabled list to the plugin refresh', async () => {
    const refreshPlugins = vi.fn(async () => true)
    const result = processed({ action: 'reload-plugins', enabledPlugins: ['a', 'b'] } as never)
    expect(await run(builtinCommands['reload-plugins']({ result, refreshPlugins } as unknown as CommandContext))).toEqual([])
    expect(refreshPlugins).toHaveBeenCalledWith(['a', 'b'])
  })

  it('/clear opens a new conversation in the store before the session starts over', async () => {
    const order: string[] = []
    const ledger = {
      sessionStartSource: null as string | null,
      config: { conversationStore: { startNewConversation: async () => void order.push('store') } },
      startOver: () => void order.push('startOver'),
    }
    const skillsFound = new Set(['x'])
    await run(
      builtinCommands.clear({
        ledger,
        result: processed({ action: 'clear' }),
        callContext: { skillsFound, options: {}, messages: [] },
      } as unknown as CommandContext),
    )
    expect(order).toEqual(['store', 'startOver'])
    expect(ledger.sessionStartSource).toBe('clear')
    expect(skillsFound.size).toBe(0)
  })
})
