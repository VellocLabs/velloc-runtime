/**
 * The mod-authoring skill's worked examples (F-25): four complete mods, each
 * with its tests. Every one passes `ModValidate`, `tsc -p` against the types
 * folder, and `ModTest` (checked by a unit test), so the skill never teaches
 * a mod this engine refuses.
 */

import { MOD_API_SPECIFIER, MOD_TEST_KIT_SPECIFIER } from '../../../mods/modCompiler'
import { PLUGIN_MANIFEST_DIR_NAME } from '../../../pluginHost/pluginDirs'

export type ModExample = {
  /** The plugin's name and folder name. */
  name: string
  /** What it shows, one line. */
  title: string
  /** Files by path relative to the plugin folder. */
  files: Record<string, string>
}

const API = MOD_API_SPECIFIER
const KIT = MOD_TEST_KIT_SPECIFIER

const lines = (...text: string[]): string => `${text.join('\n')}\n`

function plugin(name: string, description: string, title: string, hooks: string, tests: string): ModExample {
  return {
    name,
    title,
    files: {
      [`${PLUGIN_MANIFEST_DIR_NAME}/plugin.json`]: `${JSON.stringify({ name, version: '0.1.0', description }, null, 2)}\n`,
      'hooks/hooks.json': `${JSON.stringify({ modules: ['./index.ts'] }, null, 2)}\n`,
      'hooks/index.ts': hooks,
      'hooks/index.test.ts': tests,
    },
  }
}

const PANE = plugin(
  'notes-pane',
  'A pane beside the chat that keeps short notes.',
  'a pane: opened at session start, drawn from $.state, an Input that writes it',
  lines(
    `import type { Register } from '${API}'`,
    `import { atom, read, update } from '${API}'`,
    '',
    "const notes = atom<string[]>({ plugin: 'notes-pane', key: 'notes' }, [])",
    '',
    'export const register: Register = on => {',
    "  on('session.start', async ($, e, next) => {",
    "    await $.ui.open({ id: 'notes', title: 'Notes' })",
    '    return next(e)',
    '  })',
    '',
    "  on('ui.render', { component: 'Pane', requestId: 'notes' }, async ($, e) => {",
    '    const { Box, Text, Input } = $.ui.resolve(e)',
    '    const list = await read($, notes)',
    '    return Box({',
    "      flexDirection: 'column',",
    '      children: [',
    "        ...list.map((note, i) => Text({ key: `note-${i}`, children: ['• ' + note] })),",
    '        Input({',
    "          key: 'add',",
    "          placeholder: 'Add a note',",
    '          onSubmit: async (value: string) => {',
    '            const text = value.trim()',
    '            if (text) await update($, notes, current => [...current, text])',
    '          },',
    '        }),',
    '      ],',
    '    })',
    '  })',
    '}',
  ),
  lines(
    `import { describe, expect, loadPlugin, test } from '${KIT}'`,
    "import { register } from './index'",
    '',
    "describe('notes pane', () => {",
    "  test('opens its pane when the session starts', async () => {",
    '    const p = loadPlugin(register)',
    "    await p.fire('session.start', {})",
    "    expect(p.calls('ui.open')[0]?.args).toEqual([{ id: 'notes', title: 'Notes' }])",
    '  })',
    '',
    "  test('a submitted note is drawn', async () => {",
    '    const p = loadPlugin(register)',
    "    await p.fire('session.start', {})",
    "    const pane = await p.mount('desktop', 'Pane')",
    "    await pane.submit('add', 'buy milk')",
    "    expect(pane.text()).toContain('• buy milk')",
    "    expect(p.stateOf({ plugin: 'notes-pane', key: 'notes' })).toEqual(['buy milk'])",
    '  })',
    '})',
  ),
)

const BAND = plugin(
  'turn-counter',
  'A line above the prompt counting the turns of this session.',
  'a band: one line above the prompt, stacked on whatever is drawn beneath it',
  lines(
    `import type { Register } from '${API}'`,
    `import { atom, read, update } from '${API}'`,
    '',
    "const turns = atom({ plugin: 'turn-counter', key: 'turns' }, 0)",
    '',
    'export const register: Register = on => {',
    "  on('turn.complete', async ($, e, next) => {",
    '    await update($, turns, n => n + 1)',
    '    return next(e)',
    '  })',
    '',
    "  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {",
    '    const beneath = await next(e)',
    '    const { Box, Text } = $.ui.resolve(e)',
    '    const n = await read($, turns)',
    "    return Box({ flexDirection: 'column', children: [beneath, Text({ dimColor: true, children: ['Turns: ' + n] })] })",
    '  })',
    '}',
  ),
  lines(
    `import { expect, loadPlugin, test } from '${KIT}'`,
    "import { register } from './index'",
    '',
    "test('counts each finished turn in the band', async () => {",
    '  const p = loadPlugin(register)',
    "  await p.fire('turn.complete', {})",
    "  await p.fire('turn.complete', {})",
    "  const band = await p.mount('desktop', 'AbovePrompt')",
    "  expect(band.text()).toContain('Turns: 2')",
    '})',
  ),
)

const GUARD = plugin(
  'push-guard',
  'Refuses a force push from the shell tool.',
  'a guard on tool.call: refuses one kind of command, lets the rest through, and refuses when it fails',
  lines(
    `import type { Register } from '${API}'`,
    '',
    'const FORCE_PUSH = /\\bgit\\b.*\\spush\\b.*\\s(--force|-[a-zA-Z]*f[a-zA-Z]*\\b|\\+\\S)/',
    '',
    'export const register: Register = on => {',
    "  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {",
    "    if (e.tool === 'Bash' && FORCE_PUSH.test(e.command.replace(/\\s+/g, ' '))) {",
    "      return { deny: 'push-guard: force pushes are refused here; push without --force.' }",
    '    }',
    '    return next(e)',
    "  }).catch(async () => ({ deny: 'push-guard failed, so the command is refused.' }))",
    '}',
  ),
  lines(
    `import { describe, expect, loadPlugin, test } from '${KIT}'`,
    "import { register } from './index'",
    '',
    "const bash = (command: string) => ({ tool: 'Bash', tool_use_id: 't1', command })",
    '',
    "describe('push guard', () => {",
    "  test('refuses a force push', async () => {",
    '    const p = loadPlugin(register)',
    "    const out = await p.fire('tool.call', bash('git push --force origin main'))",
    "    expect(out.deny).toContain('force pushes are refused')",
    '  })',
    '',
    "  test('refuses the other spellings of a force push', async () => {",
    '    const p = loadPlugin(register)',
    "    for (const command of ['git -C repo push --force', 'git push -uf origin main', 'git push origin +main']) {",
    "      const out = await p.fire('tool.call', bash(command))",
    "      expect(out.deny).toContain('force pushes are refused')",
    '    }',
    '  })',
    '',
    "  test('lets an ordinary push through to the tool', async () => {",
    '    const p = loadPlugin(register)',
    "    const out = await p.fire('tool.call', bash('git push origin main'), () => ({ result: 'pushed' }))",
    "    expect(out).toEqual({ result: 'pushed' })",
    '  })',
    '',
    "  test('refuses when the check itself fails', async () => {",
    '    const p = loadPlugin(register)',
    "    const out = await p.fire('tool.call', { tool: 'Bash', tool_use_id: 't2' })",
    "    expect(out.deny).toContain('push-guard failed')",
    '  })',
    '})',
  ),
)

const COMMAND = plugin(
  'stamp-command',
  'A /stamp command that prints the time and a note.',
  'a slash command: registered at session start, answered on command.run',
  lines(
    `import type { Register } from '${API}'`,
    '',
    'export const register: Register = on => {',
    "  on('session.start', async ($, e, next) => {",
    "    await $.command.register({ name: 'stamp', description: 'Print the time, and a note if given', argumentHint: '[note]' })",
    '    return next(e)',
    '  })',
    '',
    "  on('command.run', async ($, e, next) => {",
    "    if (e.command !== 'stamp') return next(e)",
    '    const at = new Date(await $.clock.now()).toISOString()',
    "    return { text: e.args ? at + ' ' + e.args : at }",
    '  })',
    '}',
  ),
  lines(
    `import { expect, loadPlugin, test } from '${KIT}'`,
    "import { register } from './index'",
    '',
    "test('registers /stamp and answers it with the time and the note', async () => {",
    '  const p = loadPlugin(register, { now: Date.UTC(2026, 0, 2, 3, 4, 5) })',
    "  await p.fire('session.start', {})",
    "  expect(p.calls('command.register')[0]?.args[0]).toMatchObject({ name: 'stamp' })",
    "  const out = await p.fire('command.run', { command: 'stamp', args: 'deploy', origin: { kind: 'composer' } })",
    "  expect(out).toEqual({ text: '2026-01-02T03:04:05.000Z deploy' })",
    '})',
    '',
    "test('leaves other commands to the engine', async () => {",
    '  const p = loadPlugin(register)',
    "  const e = { command: 'help', args: '', origin: { kind: 'composer' } }",
    "  expect(await p.fire('command.run', e)).toEqual(e)",
    '})',
  ),
)

export const MOD_EXAMPLES: readonly ModExample[] = [PANE, BAND, GUARD, COMMAND]
