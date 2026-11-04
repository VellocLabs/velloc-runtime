import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// --no-concurrent-recompilation keeps Maglev and TurboFan jobs on the main thread. A background
// job pins the closure it compiles, and with it that render's payload, until the job is installed.
function runProduction(source: string): string {
  const flags = ['--expose-gc', '--no-concurrent-recompilation', '--input-type=module']
  return execFileSync(process.execPath, [...flags, '-e', source], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production' },
    encoding: 'utf8',
    timeout: 20_000,
  }).trim()
}

describe('assistant-ui production effect callbacks', () => {
  it('keeps callback identity and forwards arguments to the latest committed callback', () => {
    const result = runProduction(`
      import { resource, createResourceRoot, tapEffectEvent } from '@assistant-ui/tap';
      const Value = resource(({ value }) => tapEffectEvent((suffix) => value + suffix));
      const root = createResourceRoot();
      const first = root.render(Value({ value: 'first' })).getValue();
      const before = first('!');
      const latest = root.render(Value({ value: 'latest' })).getValue();
      console.log(JSON.stringify({ same: first === latest, before, after: first('?') }));
      root.unmount();
      process.exit(0);
    `)
    expect(JSON.parse(result)).toEqual({ same: true, before: 'first!', after: 'latest?' })
  })

  it('releases historical payloads while the resource remains mounted', () => {
    const result = runProduction(`
      import { resource, createResourceRoot } from '@assistant-ui/tap';
      const Value = resource(({ payload }) => ({ payload }));
      const root = createResourceRoot();
      const refs = [];
      let latest;
      for (let i = 0; i < 1000; i++) {
        const payload = { iteration: i, data: new Array(100).fill(i) };
        refs.push(new WeakRef(payload));
        latest = root.render(Value({ payload }));
      }
      const tick = () => new Promise(resolve => setImmediate(resolve));
      await tick();
      for (let i = 0; i < 4; i++) { global.gc(); await tick(); }
      console.log(JSON.stringify({ alive: refs.filter(ref => ref.deref()).length, latest: latest.getValue().payload.iteration }));
      root.unmount();
      process.exit(0);
    `)
    const { alive, latest } = JSON.parse(result)
    expect(latest).toBe(999)
    expect(alive).toBeLessThanOrEqual(2)
  })
})
