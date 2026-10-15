import { describe, expect, it } from 'vitest'
import {
  runScriptInWorker,
  serializeResult,
} from '../browser/runJs/runJsWorkerCore'

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 5))
  }
  if (!predicate()) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
}

type WorkerMsg = {
  type: string
  result?: string | null
  message?: string
  logs?: Array<{ level: string; text: string }>
  callId?: string
  noun?: string
  name?: string
  args?: unknown
  level?: string
  text?: string
  op?: string
  payload?: Record<string, unknown>
  ok?: boolean
  data?: unknown
  error?: { name: string; message: string }
  line?: number
  column?: number
  parseFailed?: boolean
}

/**
 * Drive `runScriptInWorker` over a real MessageChannel: `port1` is the worker's
 * `peer`, the test listens on `port2` (the broker side) and can answer
 * workspace fs ops (`answerFs`).
 */
function runScript(
  code: string,
  answerFs?: (msg: WorkerMsg, reply: (data: WorkerMsg) => void) => void,
  inputs?: Record<string, unknown>,
): { got: WorkerMsg[]; port2: MessagePort } {
  const channel = new MessageChannel()
  const got: WorkerMsg[] = []
  channel.port2.onmessage = (e: MessageEvent) => {
    const msg = e.data as WorkerMsg
    got.push(msg)
    if (msg.type === 'k.call' && msg.noun === 'fs' && answerFs) {
      answerFs(msg, reply => channel.port2.postMessage(reply))
    }
  }
  channel.port2.start()
  runScriptInWorker(code, channel.port1, 'proj', inputs)
  return { got, port2: channel.port2 }
}

describe('serializeResult', () => {
  it('maps nullish → null, strings verbatim, objects to pretty JSON', () => {
    expect(serializeResult(undefined)).toBeNull()
    expect(serializeResult(null)).toBeNull()
    expect(serializeResult('hello')).toBe('hello')
    expect(serializeResult(42)).toBe('42')
    expect(serializeResult({ a: 1 })).toContain('"a": 1')
  })
})

describe('runScriptInWorker', () => {
  it('runs code and posts done with the return value', async () => {
    const { got, port2 } = runScript('return 40 + 2')
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.find(m => m.type === 'k.done')?.result).toBe('42')
    port2.close()
  })

  it('streams console output as k.log lines (done carries no duplicate)', async () => {
    const { got, port2 } = runScript('console.log("hi", 5); return null')
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.some(m => m.type === 'k.log' && m.text === 'hi 5')).toBe(true)
    // The stream is the ONLY log channel — the broker accumulates it, which is
    // what keeps logs available on timeout/interrupt/crash paths too.
    expect(got.find(m => m.type === 'k.done')?.logs).toBeUndefined()
    port2.close()
  })

  it('exposes NO tool/exec/skill surface — pure mutation only', async () => {
    // SafeCode's Mutate-lane invariant: the script environment carries the
    // filesystem facade and nothing else. `tools`, `exec`, and `skill` must be
    // plain ReferenceErrors — a script cannot reach runtime tools or commands
    // from inside the worker.
    const { got, port2 } = runScript(
      // `typeof <undeclared>` is the one identifier probe that never throws.
      `return [typeof tools, typeof exec, typeof skill].join(',')`,
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.find(m => m.type === 'k.done')?.result).toBe(
      'undefined,undefined,undefined',
    )
    port2.close()
  })

  it('reports a thrown error', async () => {
    const { got, port2 } = runScript('throw new Error("boom")')
    await waitFor(() => got.some(m => m.type === 'k.error'))
    expect(got.find(m => m.type === 'k.error')?.message).toBe('boom')
    port2.close()
  })

  it('reports SyntaxError as the error name for a script that never parsed', async () => {
    // `new AsyncFunction(...)` is built inside the same try as the run, so a
    // script that failed to PARSE arrives on the same channel as a runtime
    // throw. Without the name the two are indistinguishable downstream, and
    // SuperEdit cannot tell the model which fix applies (the `inputs` split
    // answers the first and nothing about the second).
    const { got, port2 } = runScript('await writeTextFile("a.md", "unterminated)')
    await waitFor(() => got.some(m => m.type === 'k.error'))
    expect(got.find(m => m.type === 'k.error')?.name).toBe('SyntaxError')
    expect(got.find(m => m.type === 'k.error')?.parseFailed).toBe(true)
    port2.close()
  })

  it('a SyntaxError thrown while the script RUNS is not flagged as a parse failure', async () => {
    // Same error name as a script that never parsed, but the script did — the
    // fix is the data / regex, not the script's layout.
    const { got, port2 } = runScript('return JSON.parse("{ bad json")')
    await waitFor(() => got.some(m => m.type === 'k.error'))
    const err = got.find(m => m.type === 'k.error')!
    expect(err.name).toBe('SyntaxError')
    expect(err.parseFailed).toBeUndefined()
    port2.close()
  })

  it('an un-awaited helper chain finishes every step before done is posted', async () => {
    // `replaceTextFile` reads, then writes once the read lands. Un-awaited, only
    // the read was in flight when the script returned; the worker used to
    // reject it at `done`, so the write was never issued and the edit was lost.
    const written: Array<Record<string, unknown>> = []
    const { got, port2 } = runScript(
      `replaceTextFile('a.ts', 'two', 'three'); return 'ret'`,
      (msg, reply) => {
        if (msg.op === 'writeFile') written.push(msg.payload!)
        // Answer on a later macrotask, like a real broker round trip.
        setTimeout(
          () =>
            reply({
              type: 'k.callResult',
              callId: msg.callId,
              ok: true,
              data:
                msg.op === 'readFile'
                  ? { bytes: new TextEncoder().encode('one two\n') }
                  : null,
            } as WorkerMsg),
          5,
        )
      },
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    const doneAt = got.findIndex(m => m.type === 'k.done')
    const writeAt = got.findIndex(m => m.type === 'k.call' && m.noun === 'fs' && m.op === 'writeFile')
    expect(writeAt).toBeGreaterThanOrEqual(0)
    expect(writeAt).toBeLessThan(doneAt)
    expect(new TextDecoder().decode(written[0]!.bytes as Uint8Array)).toBe('one three\n')
    expect(got.find(m => m.type === 'k.done')?.result).toBe('ret')
    // The missing await is still called out.
    expect(
      got.some(m => m.type === 'k.log' && m.level === 'warn' && /missing await/.test(m.text ?? '')),
    ).toBe(true)
    port2.close()
  })

  it('reports the error name for a runtime throw too', async () => {
    const { got, port2 } = runScript('missingFn()')
    await waitFor(() => got.some(m => m.type === 'k.error'))
    expect(got.find(m => m.type === 'k.error')?.name).toBe('ReferenceError')
    port2.close()
  })

  it('reports SCRIPT-relative line/column for a thrown error (wrapper offset adjusted)', async () => {
    // The script runs inside a `new AsyncFunction(...)` wrapper whose header
    // shifts every stack line by a constant; the worker derives that offset
    // at runtime with a probe and subtracts it. Line 3 of the SCRIPT must be
    // reported as line 3 — a raw V8 stack number here would be wrong.
    const { got, port2 } = runScript('const a = 1\nconst b = 2\nmissingFn()')
    await waitFor(() => got.some(m => m.type === 'k.error'))
    const err = got.find(m => m.type === 'k.error')!
    expect(err.message).toContain('missingFn')
    expect(err.line).toBe(3)
    expect(err.column).toBeGreaterThanOrEqual(1)
    port2.close()
  })

  it('exposes a workspace facade whose ops round-trip over the peer', async () => {
    const { got, port2 } = runScript(
      `const f = await workspace.getFileHandle('a.txt')
       const file = await f.getFile()
       return workspace.name + ':' + (await file.text())`,
      (msg, reply) => {
        if (msg.op === 'stat') {
          reply({
            type: 'k.callResult',
            callId: msg.callId,
            ok: true,
            data: { kind: 'file', size: 2 },
          } as WorkerMsg)
        } else {
          reply({
            type: 'k.callResult',
            callId: msg.callId,
            ok: true,
            data: { bytes: new TextEncoder().encode('hi') },
          } as WorkerMsg)
        }
      },
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.find(m => m.type === 'k.done')?.result).toBe('proj:hi')
    port2.close()
  })

  it('a refused workspace op reaches the script as a platform-named exception', async () => {
    const { got, port2 } = runScript(
      `try { await workspace.getFileHandle('a.txt') } catch (e) { return e.name }`,
      (msg, reply) =>
        reply({
          type: 'k.callResult',
          callId: msg.callId,
          ok: false,
          error: { name: 'NotAllowedError', message: 'denied by rule' },
        } as WorkerMsg),
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.find(m => m.type === 'k.done')?.result).toBe('NotAllowedError')
    port2.close()
  })

  it('exposes getDirectory(absPath) that anchors ops with a root', async () => {
    const { got, port2 } = runScript(
      `const d = await getDirectory('/abs/place')
       const f = await d.getFileHandle('a.txt')
       return (await (await f.getFile()).text())`,
      (msg, reply) => {
        if (msg.op === 'stat') {
          reply({
            type: 'k.callResult',
            callId: msg.callId,
            ok: true,
            data: { kind: msg.payload?.path === '' ? 'directory' : 'file', size: 1 },
          } as WorkerMsg)
        } else {
          reply({
            type: 'k.callResult',
            callId: msg.callId,
            ok: true,
            data: { bytes: new TextEncoder().encode('anchored') },
          } as WorkerMsg)
        }
      },
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    // Every fs op from the anchored handle carries the root.
    for (const m of got.filter(m => m.type === 'k.call' && m.noun === 'fs')) {
      expect(m.payload?.root).toBe('/abs/place')
    }
    expect(got.find(m => m.type === 'k.done')?.result).toBe('anchored')
    port2.close()
  })

  it('binds all six one-call helpers as script globals', async () => {
    const { got, port2 } = runScript(
      `return [typeof readTextFile, typeof writeTextFile, typeof replaceTextFile, typeof readFileBytes, typeof writeFileBytes, typeof move].join(',')`,
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.find(m => m.type === 'k.done')?.result).toBe(
      'function,function,function,function,function,function',
    )
    port2.close()
  })

  it('exposes readTextFile/writeTextFile one-call helpers over the same pipe', async () => {
    const written: Array<Record<string, unknown>> = []
    const { got, port2 } = runScript(
      // A backslashed Windows-relative path in, one read + one write out.
      `const s = await readTextFile('src\\\\a.txt')
       await writeTextFile('out\\\\b.txt', s + '!')
       return s`,
      (msg, reply) => {
        if (msg.op === 'writeFile') written.push(msg.payload!)
        reply({
          type: 'k.callResult',
          callId: msg.callId,
          ok: true,
          data:
            msg.op === 'readFile'
              ? { bytes: new TextEncoder().encode('hi') }
              : null,
        } as WorkerMsg)
      },
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.find(m => m.type === 'k.done')?.result).toBe('hi')
    // Exactly one op per helper call — no stat walk, separators normalized.
    expect(
      got.filter(m => m.type === 'k.call' && m.noun === 'fs').map(m => [m.op, m.payload?.path]),
    ).toEqual([
      ['readFile', 'src/a.txt'],
      ['writeFile', 'out/b.txt'],
    ])
    expect(new TextDecoder().decode(written[0]!.bytes as Uint8Array)).toBe('hi!')
    port2.close()
  })

  it('replaceTextFile is one read + one write with the edit applied', async () => {
    const written: Array<Record<string, unknown>> = []
    const { got, port2 } = runScript(
      `return await replaceTextFile('src\\\\a.txt', 'two', 'three')`,
      (msg, reply) => {
        if (msg.op === 'writeFile') written.push(msg.payload!)
        reply({
          type: 'k.callResult',
          callId: msg.callId,
          ok: true,
          data:
            msg.op === 'readFile'
              ? { bytes: new TextEncoder().encode('one two\n') }
              : null,
        } as WorkerMsg)
      },
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    // The occurrence count reaches the host (serializeResult renders the
    // number as text, like every other run_js return value).
    expect(got.find(m => m.type === 'k.done')?.result).toBe('1')
    expect(
      got.filter(m => m.type === 'k.call' && m.noun === 'fs').map(m => [m.op, m.payload?.path]),
    ).toEqual([
      ['readFile', 'src/a.txt'],
      ['writeFile', 'src/a.txt'],
    ])
    expect(new TextDecoder().decode(written[0]!.bytes as Uint8Array)).toBe(
      'one three\n',
    )
    port2.close()
  })

  // ── `inputs` — data values, never parsed as source ─────────────────────────
  //
  // The code/data split exists to kill the escaping failure mode: models used
  // to embed file content in JS string literals and trip the parser
  // ("Unexpected identifier", "Invalid or unexpected token"). `inputs` rides
  // the postMessage structured clone and reaches the script as a parameter
  // VALUE, so the hostile characters below must survive verbatim.

  it('exposes `inputs` values verbatim — hostile characters never touch the parser', async () => {
    // Backticks, ${}, single/double/triple quotes, backslashes, CRLF, and a
    // markdown fence — everything that historically broke inline embedding.
    const hostile =
      '`back` ${tick} "quote" \'single\' \\\\slash \\n literal\r\n"""py"""\n```md fence```'
    const { got, port2 } = runScript('return inputs.content', undefined, {
      content: hostile,
    })
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.find(m => m.type === 'k.done')?.result).toBe(hostile)
    port2.close()
  })

  it('non-string inputs values arrive as their structured-clone selves', async () => {
    const { got, port2 } = runScript(
      'return JSON.stringify([inputs.n, inputs.arr, inputs.obj.k])',
      undefined,
      { n: 42, arr: [1, 2], obj: { k: 'v' } },
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.find(m => m.type === 'k.done')?.result).toBe('[42,[1,2],"v"]')
    port2.close()
  })

  it('`inputs` defaults to {} when the run supplies none', async () => {
    const { got, port2 } = runScript(
      'return typeof inputs + ":" + String(inputs.missing)',
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.find(m => m.type === 'k.done')?.result).toBe(
      'object:undefined',
    )
    port2.close()
  })
})

/** Drive a `shell`-mode script: the test answers `k.call (shell)` ops. */
function runShellScript(
  code: string,
  answerShell: (msg: WorkerMsg, reply: (data: WorkerMsg) => void) => void,
  inputs?: Record<string, unknown>,
): { got: WorkerMsg[]; port2: MessagePort } {
  const channel = new MessageChannel()
  const got: WorkerMsg[] = []
  channel.port2.onmessage = (e: MessageEvent) => {
    const msg = e.data as WorkerMsg
    got.push(msg)
    if (msg.type === 'k.call' && msg.noun === 'shell') {
      answerShell(msg, reply => channel.port2.postMessage(reply))
    }
  }
  channel.port2.start()
  runScriptInWorker(code, channel.port1, 'proj', inputs, 'shell')
  return { got, port2: channel.port2 }
}

describe('runScriptInWorker — shell mode (SuperShell)', () => {
  it('exposes bash + inputs + console and NO workspace facade or file helpers', async () => {
    const { got, port2 } = runShellScript(
      'return [typeof bash, typeof inputs, typeof console, typeof workspace, typeof readTextFile, typeof writeTextFile, typeof getDirectory].join(",")',
      () => {},
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.find(m => m.type === 'k.done')?.result).toBe(
      'function,object,object,undefined,undefined,undefined,undefined',
    )
    port2.close()
  })

  it('an edit-mode script has no bash', async () => {
    const { got, port2 } = runScript('return typeof bash')
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.find(m => m.type === 'k.done')?.result).toBe('undefined')
    port2.close()
  })

  it('bash round-trips over the peer and resolves the step result', async () => {
    const { got, port2 } = runShellScript(
      'const r = await bash("git status --short", { stdin: inputs.s }); return r.stdout.trim() + "|" + r.exitCode',
      (msg, reply) =>
        reply({
          type: 'k.callResult',
          callId: msg.callId,
          ok: true,
          data: { result: { stdout: ' M a.ts\n', stderr: '', exitCode: 0, truncated: false } },
        }),
      { s: 'payload' },
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    const call = got.find(m => m.type === 'k.call' && m.noun === 'shell')!
    expect(call.op).toBe('run')
    expect(call.payload).toEqual({ command: 'git status --short', options: { stdin: 'payload' } })
    expect(got.find(m => m.type === 'k.done')?.result).toBe('M a.ts|0')
    port2.close()
  })

  it('an error record crosses the real MessageChannel and is rebuilt as ShellRunFailure with every field', async () => {
    // Structured clone does not keep an Error's custom fields, so the host sends
    // a plain record; this pins that the SCRIPT receives kind/exitCode/stdout/
    // stderr/truncated after a genuine clone, not just the host-side object.
    const { got, port2 } = runShellScript(
      'try { await bash("sleep 100", { nothrow: true }) } catch (e) { return JSON.stringify([e instanceof Error, e.name, e.kind, e.exitCode, e.stdout, e.stderr, e.truncated, e.message]) }',
      (msg, reply) =>
        reply({
          type: 'k.callResult',
          callId: msg.callId,
          ok: true,
          data: {
            error: {
              kind: 'timeout',
              message: 'Command timed out after 1s: sleep 100',
              exitCode: null,
              stdout: 'partial',
              stderr: 'warn',
              truncated: true,
            },
          },
        }),
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(JSON.parse(got.find(m => m.type === 'k.done')!.result as string)).toEqual([
      true,
      'ShellError',
      'timeout',
      null,
      'partial',
      'warn',
      true,
      // The message gains the end of the output (stderr first), as it would if
      // the error ended the script.
      'Command timed out after 1s: sleep 100\nwarn',
    ])
    port2.close()
  })

  it('a non-zero exit result becomes ShellRunFailure kind failed in the script', async () => {
    const { got, port2 } = runShellScript(
      'try { await bash("false") } catch (e) { return e.kind + ":" + e.exitCode }',
      (msg, reply) =>
        reply({
          type: 'k.callResult',
          callId: msg.callId,
          ok: true,
          data: { result: { stdout: '', stderr: '', exitCode: 1, truncated: false } },
        }),
    )
    await waitFor(() => got.some(m => m.type === 'k.done'))
    expect(got.find(m => m.type === 'k.done')?.result).toBe('failed:1')
    port2.close()
  })

  it('reports script-relative line numbers in shell mode too', async () => {
    const { got, port2 } = runShellScript('const a = 1\nnull.x', () => {})
    await waitFor(() => got.some(m => m.type === 'k.error'))
    expect(got.find(m => m.type === 'k.error')?.line).toBe(2)
    port2.close()
  })
})
