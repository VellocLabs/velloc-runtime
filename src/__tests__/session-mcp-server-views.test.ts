/**
 * The session snapshot's MCP server list: settled servers only, by name.
 */
import { describe, expect, it } from 'vitest'
import { sessionMcpServerViews } from '../browser/worker/workerSnapshot'

describe('sessionMcpServerViews', () => {
  it('keeps connected and failed servers, sorted by name; drops connecting and closed ones', () => {
    expect(
      sessionMcpServerViews([
        { name: 'zeta', status: 'connected' },
        { name: 'beta', status: 'connecting' },
        { name: 'alpha', status: 'failed' },
        { name: 'gamma', status: 'closed' },
        { name: 'delta', status: 'connected' },
      ]),
    ).toEqual([
      { name: 'alpha', status: 'failed' },
      { name: 'delta', status: 'connected' },
      { name: 'zeta', status: 'connected' },
    ])
  })

  it('is empty for a pool with no servers', () => {
    expect(sessionMcpServerViews([])).toEqual([])
  })
})
