import { describe, expect, it } from 'vitest'
import { readBashEnvelope } from '../input/pluginInstallCommands'

describe('readBashEnvelope', () => {
  it('reads the host\'s structured shell result', () => {
    expect(
      readBashEnvelope({
        data: { stdout: 'out', stderr: 'err', exit_code: 128, timed_out: false, truncated: false },
        agent_meta: {},
      }),
    ).toEqual({ output: 'out\nerr', exitCode: 128 })
  })

  it('still reads an {output, exit_code} body and a plain string', () => {
    expect(readBashEnvelope({ output: 'x', exit_code: 2 })).toEqual({ output: 'x', exitCode: 2 })
    expect(readBashEnvelope('done')).toEqual({ output: 'done', exitCode: 0 })
  })
})
