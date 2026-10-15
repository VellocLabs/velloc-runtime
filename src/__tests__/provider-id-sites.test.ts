/**
 * Provider mods PM-6b - the codecs' id sites: where each wire format carries
 * ids in the request body it builds. Built through the real codecs, then read
 * back with `idSites`; the sites' paths must lead to the very strings listed.
 */
import { describe, expect, it } from 'vitest'
import type { BridgeModelRequestPayload } from '../browser/bridge/browserBridgeProtocol'
import { anthropicMessagesDriver } from '../models/drivers/anthropicMessagesDriver'
import type { DriverRequestContext, IdSite, ProviderDriver } from '../models/drivers/driverTypes'
import { geminiDriver } from '../models/drivers/geminiDriver'
import { chatIdSites, geminiIdSites, messagesIdSites, responsesIdSites } from '../models/drivers/idSites'
import { registerProviderDriver } from '../models/drivers/driverRegistry'
import { createModelProvider } from '../models/drivers/modelProvider'
import { ollamaChatDriver } from '../models/drivers/ollamaChatDriver'
import { openaiChatDriver } from '../models/drivers/openaiChatDriver'
import { openaiResponsesDriver } from '../models/drivers/openaiResponsesDriver'

const context: DriverRequestContext = { providerId: 'acme', baseUrl: 'https://api.example.com/v1', model: 'm-1' }

const payload = {
  messages: [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reading' },
        { type: 'tool-call', toolCallId: 'call_A', toolName: 'Read', args: { path: '/a' } },
        { type: 'tool-call', toolCallId: 'call_B', toolName: 'Read', args: { path: '/b' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'call_A', toolName: 'Read', result: 'a' },
        { type: 'tool-result', toolCallId: 'call_B', toolName: 'Read', result: 'b' },
      ],
    },
  ],
} as unknown as BridgeModelRequestPayload

function bodyOf(driver: ProviderDriver): unknown {
  return JSON.parse(new TextDecoder().decode(driver.buildRequest(payload, context).body))
}

function at(root: unknown, path: ReadonlyArray<string | number>): unknown {
  return path.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], root)
}

/** Every site's path leads to its value, and its message path to an object. */
function expectConsistent(body: unknown, sites: IdSite[]): void {
  for (const site of sites) {
    expect(at(body, site.path)).toBe(site.value)
    expect(typeof at(body, site.messagePath)).toBe('object')
    expect(site.path.slice(0, site.messagePath.length)).toEqual(site.messagePath)
  }
}

describe('codec id sites', () => {
  it('openai-chat: tool call ids on the assistant message and the results\' references, in order', () => {
    const body = bodyOf(openaiChatDriver)
    const sites = openaiChatDriver.idSites!(body)
    expect(sites.map(s => [s.kind, s.value, s.index, s.role, s.path.join('.')])).toEqual([
      ['toolCall', 'call_A', 1, 'assistant', 'messages.1.tool_calls.0.id'],
      ['toolCall', 'call_B', 1, 'assistant', 'messages.1.tool_calls.1.id'],
      ['toolCall', 'call_A', 2, 'tool', 'messages.2.tool_call_id'],
      ['toolCall', 'call_B', 3, 'tool', 'messages.3.tool_call_id'],
    ])
    expectConsistent(body, sites)
  })

  it('ollama-chat: the same chat-shaped sites', () => {
    const body = bodyOf(ollamaChatDriver)
    const sites = ollamaChatDriver.idSites!(body)
    expect(sites.filter(s => s.role === 'assistant').map(s => s.value)).toEqual(['call_A', 'call_B'])
    expectConsistent(body, sites)
  })

  it('openai-responses: call_id of a function call and of its output', () => {
    const body = bodyOf(openaiResponsesDriver)
    const sites = openaiResponsesDriver.idSites!(body)
    expect(sites.map(s => [s.kind, s.value, s.role])).toEqual([
      ['toolCall', 'call_A', 'assistant'],
      ['toolCall', 'call_B', 'assistant'],
      ['toolCall', 'call_A', 'tool'],
      ['toolCall', 'call_B', 'tool'],
    ])
    expect(sites.every(s => s.path[s.path.length - 1] === 'call_id')).toBe(true)
    expectConsistent(body, sites)
  })

  it('openai-responses: item ids are message ids, a reasoning item\'s is the reasoning kind', () => {
    const sites = responsesIdSites({
      input: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'message', role: 'assistant', id: 'msg_1', content: 'x' },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'T', arguments: '{}' },
        { type: 'message', role: 'user', content: 'no id' },
      ],
    })
    expect(sites.map(s => [s.kind, s.value])).toEqual([
      ['reasoning', 'rs_1'],
      ['message', 'msg_1'],
      ['toolCall', 'call_1'],
      ['message', 'fc_1'],
    ])
  })

  it('anthropic-messages: tool_use ids and tool_result references inside content blocks', () => {
    const body = bodyOf(anthropicMessagesDriver)
    const sites = anthropicMessagesDriver.idSites!(body)
    expect(sites.map(s => [s.value, s.index, s.role, s.path[s.path.length - 1]])).toEqual([
      ['call_A', 1, 'assistant', 'id'],
      ['call_B', 1, 'assistant', 'id'],
      ['call_A', 2, 'user', 'tool_use_id'],
      ['call_B', 2, 'user', 'tool_use_id'],
    ])
    expectConsistent(body, sites)
  })

  it('anthropic-messages: a server tool use is a tool call too', () => {
    const sites = messagesIdSites({
      messages: [{ role: 'assistant', content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search' }, { type: 'text', text: 't' }] }],
    })
    expect(sites.map(s => s.value)).toEqual(['srv_1'])
  })

  it('gemini: this codec writes no function call ids, so it lists none; ids a body does carry are found', () => {
    expect(geminiDriver.idSites!(bodyOf(geminiDriver))).toEqual([])
    const sites = geminiIdSites({
      contents: [
        { role: 'model', parts: [{ functionCall: { id: 'g1', name: 'T', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'g1', name: 'T', response: {} } }] },
      ],
    })
    expect(sites.map(s => [s.value, s.index, s.role, s.path.join('.')])).toEqual([
      ['g1', 0, 'model', 'contents.0.parts.0.functionCall.id'],
      ['g1', 1, 'user', 'contents.1.parts.0.functionResponse.id'],
    ])
  })

  it('a body with nothing id-like, or not the format at all, lists nothing', () => {
    for (const sites of [chatIdSites, responsesIdSites, messagesIdSites, geminiIdSites]) {
      expect(sites(undefined)).toEqual([])
      expect(sites('text')).toEqual([])
      expect(sites({})).toEqual([])
      expect(sites({ messages: [null, 3, { role: 'user', content: 'hi' }], input: [null], contents: [{}] })).toEqual([])
    }
    // An empty id is not an id.
    expect(chatIdSites({ messages: [{ role: 'tool', tool_call_id: '' }] })).toEqual([])
  })

  it('a ModelProvider exposes its codec\'s sites, bound to the codec', () => {
    registerProviderDriver(openaiChatDriver)
    const provider = createModelProvider({ id: 'acme', format: 'openai-chat', baseUrl: 'https://api.example.com/v1' })
    const body = bodyOf(openaiChatDriver)
    expect(provider.idSites!(body)).toHaveLength(4)
  })
})
