/**
 * `$.process.spawn` (F-25), the child as a stream: `spawnPieces` over a fake host child (lazy start, per-pipe
 * decoding, merged unread pieces, `{ code, signal }`, `return()` killing it, the unread bound), `hostSpawnPieces`'
 * shell command, and the noun through a real `ModRuntime` (redacting hooks, `break` killing the child, refusals).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import {
  hostModProcess,
  hostSpawnPieces,
  processSpawnInput,
  shellInvocationOf,
  spawnPieces,
  spawnResultOf,
  type HostStreamChild,
  type HostStreamHandlers,
  type HostStreamSpawner,
} from '../mods/modProcess'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** A host child the test drives: what it writes, when it exits. */
function fakeChild() {
  let handlers: HostStreamHandlers | undefined
  const state = { started: 0, killed: 0, detached: 0 }
  const child: HostStreamChild = {
    kill: async () => {
      state.killed += 1
      return true
    },
    detach: () => {
      state.detached += 1
    },
  }
  return {
    state,
    start: async (h: HostStreamHandlers): Promise<HostStreamChild> => {
      state.started += 1
      handlers = h
      return child
    },
    write: (stream: 'stdout' | 'stderr', data: Uint8Array | string) =>
      handlers!.onOutput(stream, typeof data === 'string' ? bytes(data) : data),
    exit: (exitCode: number, signal?: number) => handlers!.onExit({ exitCode, ...(signal !== undefined ? { signal } : {}) }),
  }
}

describe('the request and the result', () => {
  it('the request is checked by name; cwd and env as run takes them', () => {
    expect(processSpawnInput([{ argv: ['make'], cwd: 'build', env: { A: '1' }, input: 'x' }])).toEqual({
      argv: ['make'],
      cwd: 'build',
      env: { A: '1' },
      input: 'x',
    })
    expect(() => processSpawnInput([['make']])).toThrow('$.process.spawn(request): request must be an object')
    expect(() => processSpawnInput([{ argv: [] }])).toThrow('$.process.spawn(request): argv must be a non-empty list of strings')
    expect(() => processSpawnInput([{ argv: ['make'], stdin: 'x' }])).toThrow('request takes no field named "stdin"')
    expect(() => processSpawnInput([{ argv: ['make'], input: 1 }])).toThrow('request.input must be a string')
    expect(() => processSpawnInput([{ argv: ['make'], env: { 'A-B': '1' } }])).toThrow('$.process.spawn: request.env.A-B must be a string')
  })

  it('an exit is its code; a signal is its name and a null code', () => {
    expect(spawnResultOf({ exitCode: 3 })).toEqual({ code: 3, signal: null })
    expect(spawnResultOf({ exitCode: -1, signal: 15 })).toEqual({ code: null, signal: 'SIGTERM' })
    expect(spawnResultOf({ exitCode: -1, signal: 31 })).toEqual({ code: null, signal: 'SIG31' })
  })
})

describe('spawnPieces', () => {
  it('starts at the first pull, decodes a character split across two writes whole, merges what waits unread, and returns how it ended', async () => {
    const child = fakeChild()
    const pieces = spawnPieces(child.start)
    await tick()
    expect(child.state.started).toBe(0)
    const first = pieces.next()
    await tick()
    expect(child.state.started).toBe(1)
    // "é" is two bytes: the first write ends inside it.
    const e = bytes('é')
    child.write('stdout', new Uint8Array([...bytes('caf'), e[0]!]))
    expect(await first).toEqual({ done: false, value: { stream: 'stdout', text: 'caf' } })
    child.write('stdout', new Uint8Array([e[1]!, ...bytes('\n')]))
    child.write('stdout', 'line 2\n')
    child.write('stderr', 'warn\n')
    child.write('stdout', 'tail')
    child.exit(2)
    expect(await pieces.next()).toEqual({ done: false, value: { stream: 'stdout', text: 'é\nline 2\n' } })
    expect(await pieces.next()).toEqual({ done: false, value: { stream: 'stderr', text: 'warn\n' } })
    expect(await pieces.next()).toEqual({ done: false, value: { stream: 'stdout', text: 'tail' } })
    expect(await pieces.next()).toEqual({ done: true, value: { code: 2, signal: null } })
    expect(await pieces.next()).toEqual({ done: true, value: { code: 2, signal: null } })
    expect(child.state.killed).toBe(0)
  })

  it('return() answers a pull in flight at once and kills the child', async () => {
    const child = fakeChild()
    const pieces = spawnPieces(child.start)
    const waiting = pieces.next()
    await tick()
    await pieces.return!()
    expect(await waiting).toEqual({ done: true, value: undefined })
    expect(child.state).toEqual({ started: 1, killed: 1, detached: 1 })
    // What it writes after is nobody's.
    child.write('stdout', 'late')
    expect(await pieces.next()).toEqual({ done: true, value: undefined })
  })

  it('return() before the first pull starts nothing', async () => {
    const child = fakeChild()
    const pieces = spawnPieces(child.start)
    await pieces.return!()
    expect(await pieces.next()).toEqual({ done: true, value: undefined })
    expect(child.state.started).toBe(0)
  })

  it('a child that cannot start rejects the first pull', async () => {
    const pieces = spawnPieces(async () => {
      throw new Error('BINARY_NOT_FOUND: nope')
    })
    await expect(pieces.next()).rejects.toThrow('BINARY_NOT_FOUND: nope')
  })

  it('past the unread bound the child is killed: what was read before comes, then the pull rejects', async () => {
    const child = fakeChild()
    const pieces = spawnPieces(child.start, 8)
    const first = pieces.next()
    await tick()
    child.write('stdout', 'abc')
    expect(await first).toEqual({ done: false, value: { stream: 'stdout', text: 'abc' } })
    child.write('stdout', '12345')
    child.write('stderr', '6789')
    expect(child.state.killed).toBe(1)
    child.write('stdout', 'dropped')
    expect(await pieces.next()).toEqual({ done: false, value: { stream: 'stdout', text: '12345' } })
    expect(await pieces.next()).toEqual({ done: false, value: { stream: 'stderr', text: '6789' } })
    await expect(pieces.next()).rejects.toThrow('the child wrote more than 8 characters the loop had not read; it was killed')
  })
})

describe('hostSpawnPieces', () => {
  it("runs the argv through a fixed command, its words in the environment, from the session's directory, input written and stdin closed; PowerShell when there is no bash", async () => {
    const specs: Array<Parameters<HostStreamSpawner>[0]> = []
    const child = fakeChild()
    const spawner: HostStreamSpawner = async (spec, handlers) => {
      specs.push(spec)
      if (spec.shell === 'bash') throw new Error('BINARY_NOT_FOUND: bash')
      return child.start(handlers)
    }
    const pieces = hostSpawnPieces(spawner, { argv: ['make', 'my target'], cwd: 'build', env: { A: '1' }, input: 'in' }, { cwd: '/work/p' })
    const first = pieces.next()
    await tick()
    child.exit(0)
    expect(await first).toEqual({ done: true, value: { code: 0, signal: null } })
    const bash = shellInvocationOf(['make', 'my target'], 'build', 'bash')
    const powershell = shellInvocationOf(['make', 'my target'], 'build', 'powershell')
    expect(specs).toEqual([
      { shell: 'bash', command: bash.command, cwd: '/work/p', env: { A: '1', ...bash.env }, stdinText: 'in', closeStdin: true },
      { shell: 'powershell', command: powershell.command, cwd: '/work/p', env: { A: '1', ...powershell.env }, stdinText: 'in', closeStdin: true },
    ])
  })

  it('a word or an env value holding a secret placeholder is refused before anything starts', async () => {
    const specs: unknown[] = []
    const spawner: HostStreamSpawner = async spec => {
      specs.push(spec)
      throw new Error('never')
    }
    await expect(hostSpawnPieces(spawner, { argv: ['echo', '{{secret:TOKEN}}'] }, { cwd: '/w' }).next()).rejects.toThrow(
      '$.process.spawn: an argument holds "{{secret:", which a mod cannot pass',
    )
    await expect(hostSpawnPieces(spawner, { argv: ['env'], env: { T: 'x{{secret:TOKEN}}' } }, { cwd: '/w' }).next()).rejects.toThrow(
      '$.process.spawn: env.T holds "{{secret:", which a mod cannot pass',
    )
    expect(specs).toEqual([])
  })

  it('any other rejection is the first pull’s', async () => {
    const pieces = hostSpawnPieces(
      async () => {
        throw new Error('INVALID_ARGS: cwd')
      },
      { argv: ['ls'] },
      { cwd: '/w' },
    )
    await expect(pieces.next()).rejects.toThrow('INVALID_ARGS: cwd')
  })

  it('without a session folder: an absolute cwd is the start folder; otherwise refused before the host is asked', async () => {
    const specs: Array<Parameters<HostStreamSpawner>[0]> = []
    const spawner: HostStreamSpawner = async spec => {
      specs.push(spec)
      throw new Error('stop here')
    }
    await expect(hostSpawnPieces(spawner, { argv: ['ls'], cwd: '/elsewhere' }, { cwd: '' }).next()).rejects.toThrow('stop here')
    expect(specs.map(s => s.cwd)).toEqual(['/elsewhere'])
    await expect(hostSpawnPieces(spawner, { argv: ['ls'] }, { cwd: '' }).next()).rejects.toThrow(
      '$.process.spawn: this session has no working folder; pass an absolute cwd',
    )
    expect(specs).toHaveLength(1)
  })
})

describe('$.process.spawn through the runtime', () => {
  let uniq = 0
  function world(modules: Record<string, string>, host: Partial<ModNounHost> = {}) {
    const reports: string[] = []
    const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
    const runtime = new ModRuntime({
      modules: refs,
      readModule: async path => `${modules[path.split('/')[2]!]}\n// load ${++uniq}`,
      openWorker: async (): Promise<ModWorkerHandle> => {
        const channel = new MessageChannel()
        open.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
        const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
          settle = resolve
        })
        return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      },
      session: { id: () => 's', cwd: () => '/work/project', ...host },
      report: line => reports.push(line),
    })
    runtimes.push(runtime)
    return { runtime, reports }
  }

  /** A host whose children write `script` and exit, each recorded. */
  function scriptedHost(script: (spec: Parameters<HostStreamSpawner>[0], child: ReturnType<typeof fakeChild>) => void) {
    const children: Array<{ spec: Parameters<HostStreamSpawner>[0]; child: ReturnType<typeof fakeChild> }> = []
    const spawnStream: HostStreamSpawner = async (spec, handlers) => {
      const child = fakeChild()
      const started = await child.start(handlers)
      children.push({ spec, child })
      queueMicrotask(() => script(spec, child))
      return started
    }
    const process = hostModProcess(async () => ({ output: '', exitCode: 0 }), { cwd: '/work/project', spawnStream })
    return { process, children }
  }

  it("a mod reads a child's pieces and how it ended; another plugin's process.spawn hook redacts each piece", async () => {
    const host = scriptedHost((_spec, child) => {
      child.write('stdout', 'token=SECRET\n')
      child.write('stderr', 'oops SECRET\n')
      child.exit(0)
    })
    const { runtime, reports } = world(
      {
        redact: `
          export function register(on) {
            on('process.spawn', async function* ($, e, next) {
              const stream = next(e);
              for await (const chunk of stream) yield { ...chunk, text: chunk.text.replaceAll('SECRET', '***') };
              return stream.result;
            });
          }
        `,
        runner: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const make = $.process.spawn({ argv: ['make'], cwd: 'build' });
              const seen = [];
              for await (const { stream, text } of make) seen.push(stream + ':' + text);
              await $.ui.log(JSON.stringify({ seen, ended: await make.result }));
              return next(e);
            });
          }
        `,
      },
      { process: host.process },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const line = reports.find(r => r.startsWith('runner: {'))!
    expect(JSON.parse(line.slice('runner: '.length))).toEqual({
      seen: ['stdout:token=***\n', 'stderr:oops ***\n'],
      ended: { code: 0, signal: null },
    })
    expect(host.children.map(c => c.spec.command)).toEqual([shellInvocationOf(['make'], 'build', 'bash').command])
    expect(host.children[0]!.spec.env).toMatchObject({ VELLOC_MOD_ARG_0: 'make', VELLOC_MOD_CWD: 'build' })
  })

  it('leaving the loop kills the child; a spawn never read starts nothing', async () => {
    const host = scriptedHost((_spec, child) => {
      child.write('stdout', 'first\n')
    })
    const { runtime, reports } = world(
      {
        runner: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              $.process.spawn({ argv: ['never'] });
              for await (const { text } of $.process.spawn({ argv: ['watch'] })) {
                await $.ui.log('got ' + text.trim());
                break;
              }
              return next(e);
            });
          }
        `,
      },
      { process: host.process },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    await expect.poll(() => host.children[0]?.child.state.killed).toBe(1)
    expect(reports).toEqual(['runner: got first'])
    expect(host.children.map(c => c.spec.env?.VELLOC_MOD_ARG_0)).toEqual(['watch'])
  })

  it('return() while a read is in flight ends that read, done', async () => {
    const host = scriptedHost(() => {})
    const { runtime, reports } = world(
      {
        runner: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const quiet = $.process.spawn({ argv: ['quiet'] })[Symbol.asyncIterator]();
              const pending = quiet.next();
              // A round trip, so the read is in flight before return().
              await $.ui.log('reading');
              await quiet.return();
              await $.ui.log('read ' + JSON.stringify(await pending));
              return next(e);
            });
          }
        `,
      },
      { process: host.process },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual(['runner: reading', 'runner: read {"done":true}'])
    expect(host.children[0]!.child.state.killed).toBe(1)
  })

  it("a loop the hook leaves running outlives the hook's return, and ends with the module", async () => {
    const host = scriptedHost((_spec, child) => {
      child.write('stdout', 'tick 1\n')
    })
    const { runtime, reports } = world(
      {
        bridge: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              void (async () => {
                for await (const { text } of $.process.spawn({ argv: ['bridge', 'watch'] })) await $.ui.log(text.trim());
              })();
              return next(e);
            });
          }
        `,
      },
      { process: host.process },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    await expect.poll(() => reports).toEqual(['bridge: tick 1'])
    const child = host.children[0]!.child
    // The hook returned; the child runs on and its pieces still arrive.
    child.write('stdout', 'tick 2\n')
    await expect.poll(() => reports).toEqual(['bridge: tick 1', 'bridge: tick 2'])
    expect(child.state.killed).toBe(0)
    runtime.dispose()
    expect(child.state.killed).toBe(1)
  })

  it('a bad request, and a host that cannot start a child, reject the first pull by name', async () => {
    const { runtime, reports } = world({
      probe: `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            const read = async request => {
              try {
                for await (const _ of $.process.spawn(request)) {}
                return 'ran';
              } catch (err) {
                return err.name + ': ' + err.message;
              }
            };
            await $.ui.log(await read({ argv: 'ls' }));
            await $.ui.log(await read({ argv: ['ls'] }));
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual([
      'probe: TypeError: $.process.spawn(request): argv must be a non-empty list of strings',
      'probe: NotSupportedError: $.process.spawn is not available: this session cannot start a child',
    ])
  })
})

describe('$.process.run, when the call can be abandoned', () => {
  const rig = () => {
    const child = fakeChild()
    const commands: unknown[] = []
    const process = hostModProcess(
      async args => {
        commands.push(args)
        return { output: '', exitCode: 0 }
      },
      { cwd: '/work/p', spawnStream: async (_spec, handlers) => child.start(handlers) },
    )
    return { child, commands, process }
  }

  it('runs as a child: both streams merged in order, the exit code its own', async () => {
    const { child, commands, process } = rig()
    const ran = process.run(['make'], {}, new AbortController().signal)
    await tick()
    child.write('stdout', 'a')
    child.write('stderr', 'b')
    child.write('stdout', 'c')
    child.exit(2)
    expect(await ran).toEqual({ exitCode: 2, stdout: 'abc', stderr: '' })
    expect(commands).toEqual([])
  })

  it('abandoned: rejects at once with an AbortError and kills the child', async () => {
    const { child, process } = rig()
    const controller = new AbortController()
    const ran = process.run(['sleep', '600'], {}, controller.signal)
    await tick()
    controller.abort()
    await expect(ran).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.state.killed).toBe(1)
    await expect(process.run(['ls'], {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.state.started).toBe(1)
  })

  it('a host with no streaming child: the call stops waiting the moment it is abandoned', async () => {
    const controller = new AbortController()
    const process = hostModProcess(() => new Promise(() => {}), { cwd: '/work/p' })
    const ran = process.run(['sleep', '600'], {}, controller.signal)
    controller.abort()
    await expect(ran).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('past its timeout the child is killed and the call fails, naming it', async () => {
    const { child, process } = rig()
    const ran = process.run(['sleep', '600'], { timeoutMs: 20 }, new AbortController().signal)
    await expect(ran).rejects.toThrow('$.process.run: the command did not finish within 20ms; it was stopped')
    expect(child.state.killed).toBe(1)
  })
})
