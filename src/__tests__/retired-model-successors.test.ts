// A stored pick of a shut-down model loads as its successor: settings.json's
// provider and agent fields, tier pins and session-type pins, and a session's
// saved selection.
import { describe, expect, it } from 'vitest'
import type { BrowserLlmCatalog, BrowserLlmModel } from '../browser/bridge/browserBridgeProtocol'
import { resolveSelection, toEntrySelection } from '../browser/worker/modelSelection'
import {
  successorModelId,
  withSuccessorEntries,
  withSuccessorIds,
} from '../config/nexusModelConfig/retiredModels'
import { normalizeModelTiers, normalizeSessionModelPolicy } from '../settings/sessionModelSettings'
import { normalizeSettings } from '../settings/settingsNormalize'

const CASES: ReadonlyArray<readonly [string, string]> = [
  ['gemini-3-pro-preview', 'gemini-4-carbon'],
  ['gemini-3-pro-preview-11-2025', 'gemini-4-carbon'],
  ['gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite'],
  ['gemini-3-flash-lite-preview', 'gemini-3.1-flash-lite'],
  ['gemini-3.1-flash-lite-preview-03-2026', 'gemini-3.1-flash-lite'],
  ['gemini-*-pro@3-preview', 'gemini-*-carbon@4'],
  ['gemini-*-flash-lite@3.1-preview', 'gemini-*-flash-lite@3.1'],
  ['gemini-*-flash-lite@3-preview', 'gemini-*-flash-lite@3.1'],
]

const UNCHANGED = [
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-*-pro@3.1-preview',
  'gemini-*-pro@latest',
  'gemini-3.1-flash-lite',
  'gemini-4-carbon',
]

describe('retired model successors', () => {
  it.each(CASES)('google %s moves to %s', (retired, successor) => {
    expect(successorModelId('google', retired)).toBe(successor)
  })

  it.each(UNCHANGED)('google %s is live and stays', id => {
    expect(successorModelId('google', id)).toBe(id)
  })

  it('applies under the provider that retired the id only', () => {
    expect(successorModelId('openrouter', 'gemini-3-pro-preview')).toBe('gemini-3-pro-preview')
    expect(successorModelId('custom:my-proxy', 'gemini-3.1-flash-lite-preview')).toBe('gemini-3.1-flash-lite-preview')
  })

  it('replaces retired ids in a list and folds duplicates', () => {
    expect(withSuccessorIds('google', ['gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite', 'gemini-3-pro-preview']))
      .toEqual(['gemini-3.1-flash-lite', 'gemini-4-carbon'])
  })

  it('replaces a retired pinned entry, its stored id included, and folds duplicates', () => {
    expect(withSuccessorEntries('google', [
      { family: 'gemini-*-pro', version: '3-preview', id: 'gemini-3-pro-preview' },
      { family: 'gemini-*-pro', version: 'latest' },
      { family: 'gemini-*-flash-lite', version: '3.1-preview', id: 'gemini-3.1-flash-lite-preview' },
      { family: 'gemini-*-flash-lite', version: '3.1', id: 'gemini-3.1-flash-lite' },
    ])).toEqual([
      { family: 'gemini-*-carbon', version: '4', id: 'gemini-4-carbon' },
      { family: 'gemini-*-pro', version: 'latest' },
      { family: 'gemini-*-flash-lite', version: '3.1', id: 'gemini-3.1-flash-lite' },
    ])
  })
})

describe('settings.json loads a retired pick as its successor', () => {
  it('provider fields and the agent model', () => {
    const out = normalizeSettings({
      agent: { model: { providerId: 'google', modelId: 'gemini-*-pro@3-preview', thinkingTier: 'high' } },
      providers: {
        configs: {
          google: {
            defaultModel: 'gemini-*-flash-lite@3.1-preview',
            model: 'gemini-*-flash-lite@3.1-preview',
            enabledModels: ['gemini-3-pro-preview', 'gemini-3.1-pro-preview'],
            modelEntries: [{ family: 'gemini-*-pro', version: '3-preview', id: 'gemini-3-pro-preview' }],
          },
          openrouter: { defaultModel: 'gemini-3-pro-preview' },
        },
      },
    } as never)
    expect(out.agent?.model).toEqual({ providerId: 'google', modelId: 'gemini-*-carbon@4', thinkingTier: 'high' })
    const google = out.providers?.configs.google
    expect(google?.defaultModel).toBe('gemini-*-flash-lite@3.1')
    expect(google?.model).toBe('gemini-*-flash-lite@3.1')
    expect(google?.enabledModels).toEqual(['gemini-4-carbon', 'gemini-3.1-pro-preview'])
    expect(google?.modelEntries).toEqual([{ family: 'gemini-*-carbon', version: '4', id: 'gemini-4-carbon' }])
    expect(out.providers?.configs.openrouter?.defaultModel).toBe('gemini-3-pro-preview')
  })

  it('tier pins and session-type pins', () => {
    expect(normalizeModelTiers({
      fast: { providerId: 'google', modelId: 'gemini-3.1-flash-lite-preview' },
      best: { providerId: 'google', modelId: 'gemini-3-pro-preview', thinkingTier: 'high' },
    })).toEqual({
      fast: { providerId: 'google', modelId: 'gemini-3.1-flash-lite' },
      best: { providerId: 'google', modelId: 'gemini-4-carbon', thinkingTier: 'high' },
    })
    expect(normalizeSessionModelPolicy({
      agent_tool: { mode: 'specific', providerId: 'google', modelId: 'gemini-*-pro@3-preview' },
    })).toEqual({
      agent_tool: { mode: 'specific', providerId: 'google', modelId: 'gemini-*-carbon@4' },
    })
  })
})

describe('a session saved on a retired model resumes on its successor', () => {
  const row = (id: string): BrowserLlmModel => ({ id, label: id, enabled: true, supportsStreaming: true }) as BrowserLlmModel
  const catalog = {
    providers: [{
      id: 'google',
      label: 'Google',
      enabled: true,
      models: [row('gemini-*-carbon@4'), row('gemini-*-flash-lite@3.1'), row('gemini-4-carbon'), row('gemini-3.1-flash-lite')],
    }],
    defaultSelection: { providerId: 'google', modelId: 'gemini-*-flash-lite@3.1' },
  } as unknown as BrowserLlmCatalog

  it.each([
    ['gemini-*-pro@3-preview', 'gemini-*-carbon@4'],
    ['gemini-3-pro-preview', 'gemini-4-carbon'],
    ['gemini-*-flash-lite@3.1-preview', 'gemini-*-flash-lite@3.1'],
    ['gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite'],
  ])('%s resumes as %s', (stored, successor) => {
    const persistedSelection = { providerId: 'google', modelId: stored, thinkingTier: 'medium' }
    expect(resolveSelection(catalog, { persistedSelection }))
      .toEqual({ providerId: 'google', modelId: successor, thinkingTier: 'medium' })
  })

  it('without a catalog yet, the saved pick is already the successor', () => {
    expect(toEntrySelection(null, { providerId: 'google', modelId: 'gemini-3-pro-preview' }))
      .toEqual({ providerId: 'google', modelId: 'gemini-4-carbon' })
  })
})
