// `/name` for a skill the session type's `skills:` allowlist denied — and
// for a loaded skill whose author opted out of slash invocation — must be
// SEEN by the user. Both are `shouldQuery: false` turns (the model never
// runs), and the transcript view filters `isMeta` user turns
// (assistantUiAdapter), so the earlier `createGeneratedUserMessage(...,
// { isMeta: true })` reply reached nobody: the composer simply cleared.
// They now render as localized system messages — the same shape as the
// caller's "unknown command" — so the user sees them, in their language.

import { describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { dispatchSkillSlashCommand } from '../input/skillSlashCommand'
import { renderPartsEnglish } from '../input/systemMessageParts'
import { en } from '../browser/webview/i18n/messages/en'
import { de } from '../browser/webview/i18n/messages/de'

const runtimeConfig = new BrowserRuntimeConfig()

function skill(name: string, extra: Partial<ChromiumCommandMetadata> = {}): ChromiumCommandMetadata {
  return {
    type: 'prompt',
    name,
    description: `${name} skill`,
    content: 'body',
    source: 'project',
    path: `/skills/${name}.md`,
    loadedFrom: 'skills',
    ...extra,
  } as ChromiumCommandMetadata
}

function context(commands: ChromiumCommandMetadata[], deniedSkillNames?: string[]) {
  const ctx = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    commands,
  })
  ctx.options.deniedSkillNames = deniedSkillNames
  return ctx
}

/** The i18n payload a localized system message carries (what the adapter
 *  translates), plus its English rendering. */
function localized(message: unknown): { keys: string[]; english: string } {
  const parts = (message as { i18nContent?: Array<{ key?: string }> }).i18nContent ?? []
  return {
    keys: parts.map(p => p.key).filter((k): k is string => typeof k === 'string'),
    english: renderPartsEnglish(parts as never),
  }
}

describe('dispatchSkillSlashCommand — refusals the user can see', () => {
  it('a denied skill → a visible, translated system message; no query', async () => {
    const out = await dispatchSkillSlashCommand({
      command: 'init',
      args: '',
      rawInput: '/init',
      context: context([], ['init']),
      runtimeConfig,
    })
    expect(out).not.toBeNull()
    expect(out!.shouldQuery).toBe(false)
    expect(out!.messages).toHaveLength(1)
    const message = out!.messages[0] as { type: string; isMeta?: boolean }
    // A SYSTEM message — never an isMeta user turn the transcript hides.
    expect(message.type).toBe('system')
    expect(message.isMeta).not.toBe(true)
    const { keys, english } = localized(message)
    expect(keys).toEqual(['slash.out.skillDenied'])
    expect(english).toBe('Skill /init is not available in this session type.')
  })

  it('a denied name is normalized like the lookup (leading slash dropped)', async () => {
    const out = await dispatchSkillSlashCommand({
      command: '/init',
      args: '',
      rawInput: '//init',
      context: context([], ['init']),
      runtimeConfig,
    })
    expect(localized(out!.messages[0]).english).toBe(
      'Skill /init is not available in this session type.',
    )
  })

  it('a name the session never had still falls through to the caller (null)', async () => {
    const out = await dispatchSkillSlashCommand({
      command: 'nope',
      args: '',
      rawInput: '/nope',
      context: context([], ['init']),
      runtimeConfig,
    })
    expect(out).toBeNull()
  })

  it('a loaded, model-only skill → a visible system message too', async () => {
    const out = await dispatchSkillSlashCommand({
      command: 'quiet',
      args: '',
      rawInput: '/quiet',
      context: context([skill('quiet', { userCallable: false })]),
      runtimeConfig,
    })
    expect(out!.shouldQuery).toBe(false)
    const message = out!.messages[0] as { type: string }
    expect(message.type).toBe('system')
    const { keys, english } = localized(message)
    expect(keys).toEqual(['slash.out.skillNotUserInvocable'])
    expect(english).toBe(
      'Skill /quiet cannot be invoked via slash. The model can still call it via the Skill tool.',
    )
  })

  it('both keys exist in every catalog surface the adapter reads (en + a translation)', () => {
    for (const key of ['slash.out.skillDenied', 'slash.out.skillNotUserInvocable'] as const) {
      expect(en[key]).toContain('{name}')
      expect(de[key]).toContain('{name}')
      expect(de[key]).not.toBe(en[key])
    }
  })
})
