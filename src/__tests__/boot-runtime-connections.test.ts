import { describe, expect, it, vi } from 'vitest'

import {
  createRuntimeConnections,
  type RuntimeScopeCeiling,
} from '../browser/boot/runtimeConnections'
import type { RuntimeConnection } from '../browser/runtimeClient'

/** Mocks typed as the connection's own methods; `expect()` reads them as mocks. */
function fake(name: string) {
  return {
    name,
    request: vi.fn(async () => ({})) as unknown as RuntimeConnection['request'],
    close: vi.fn() as unknown as RuntimeConnection['close'],
    welcome: null,
  }
}
type FakeConnection = ReturnType<typeof fake>

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/** A rig whose `connect` hands out named fakes and records each ceiling. */
function rig(options: {
  scopeCeiling?: RuntimeScopeCeiling
  devRelay?: { controlUrl: string; token: string }
  publish?: (connection: FakeConnection) => Promise<unknown>
} = {}) {
  const opened: Array<{ ceiling: RuntimeScopeCeiling | undefined; connection: FakeConnection }> = []
  const published: FakeConnection[] = []
  const connect = vi.fn(async (ceiling: RuntimeScopeCeiling | undefined) => {
    const connection = fake(ceiling === undefined ? `desktop-${opened.length}` : `${ceiling}-${opened.length}`)
    opened.push({ ceiling, connection })
    return connection
  })
  const connections = createRuntimeConnections<FakeConnection>({
    connect,
    scopeCeiling: options.scopeCeiling,
    publishHostEnvironment: async connection => {
      published.push(connection)
      return options.publish?.(connection)
    },
    devRelay: options.devRelay ?? null,
    trace: () => undefined,
  })
  return { connections, connect, opened, published }
}

const RELAY = { controlUrl: 'ws://127.0.0.1:1/control', token: 't' }

describe('createRuntimeConnections — unscoped (the desktop)', () => {
  it('is one connection: the UI and the shell share it, and it publishes the host environment and dials the relay', async () => {
    const { connections, connect, published } = rig({ devRelay: RELAY })
    const ui = await connections.runtime()
    const shell = await connections.desktop()
    await flush()

    expect(ui).toBe(shell)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith(undefined)
    expect(published).toEqual([ui])
    expect(ui.request).toHaveBeenCalledWith('remote.connectRelay', RELAY)
  })

  it('forgets a connection that failed, so the next caller connects afresh', async () => {
    const { connections, connect } = rig()
    connect.mockRejectedValueOnce(new Error('worker gone'))
    await expect(connections.runtime()).rejects.toThrow('worker gone')
    await flush()

    const retry = await connections.runtime()
    expect(retry.name).toBe('desktop-0')
    expect(connect).toHaveBeenCalledTimes(2)
  })
})

describe('createRuntimeConnections — ?rtScope= (the desktop guest plays a remote client)', () => {
  it('hands the UI a connection under the ceiling, and keeps an unscoped desktop connection open for the shell', async () => {
    const { connections, opened, published } = rig({ scopeCeiling: 'manager', devRelay: RELAY })
    const ui = await connections.runtime()
    const shell = await connections.desktop()
    await flush()

    expect(opened.map(o => o.ceiling)).toEqual([undefined, 'manager'])
    expect(ui).toBe(opened[1]!.connection)
    expect(shell).toBe(opened[0]!.connection)
    // The shell connection stays up: the splash reveal is sent over it at
    // fully-ready, long after the host environment went out.
    expect(shell.close).not.toHaveBeenCalled()
    // The desktop's jobs ride the desktop connection, never the scoped one.
    expect(published).toEqual([shell])
    expect(shell.request).toHaveBeenCalledWith('remote.connectRelay', RELAY)
    expect(ui.request).not.toHaveBeenCalled()
  })

  it('opens the scoped connection only after the host environment is published', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const { connections, opened } = rig({ scopeCeiling: 'control', publish: () => gate })
    const ui = connections.runtime()
    await flush()
    expect(opened.map(o => o.ceiling)).toEqual([undefined])

    release()
    expect((await ui).name).toBe('control-1')
  })

  it('a failed publish fails the UI connection and starts the shell again next time', async () => {
    let fail = true
    const { connections, opened } = rig({
      scopeCeiling: 'manager',
      publish: async () => {
        if (fail) throw new Error('publish refused')
      },
    })
    await expect(connections.runtime()).rejects.toThrow('publish refused')
    await flush()
    expect(opened[0]!.connection.close).toHaveBeenCalledTimes(1)

    fail = false
    const ui = await connections.runtime()
    expect(ui.name).toBe('manager-2')
    expect((await connections.desktop()).name).toBe('desktop-1')
  })
})
