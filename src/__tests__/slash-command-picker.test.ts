import { describe, expect, it } from 'vitest'
import {
  __testing,
  slashCommandDescription,
} from '../components/assistant-ui/slash-command-picker'
import { createTranslate } from '../browser/webview/i18n/translate'
import { en, type MessageKey } from '../browser/webview/i18n/messages/en'
import { zh } from '../browser/webview/i18n/messages/zh'
import type { SlashCommandSummary } from '../browser/worker/workerProtocol'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'
import {
  buildLoadedSkillSummaries,
  buildSlashCommandSummaries,
} from '../browser/worker/slashCommandSummaries'

const { completeSlashToken, detectSlashQuery, detectSlashToken, rankCommands } = __testing

const COMMANDS: SlashCommandSummary[] = [
  { name: 'help', description: 'Show available slash commands', kind: 'builtin' },
  { name: 'model', description: 'Switch provider/model for the next turn', kind: 'builtin' },
  { name: 'compact', description: 'Request conversation compaction', kind: 'builtin' },
  {
    name: 'review',
    description: 'Review the pending changes on this branch',
    kind: 'skill',
    source: 'project',
  },
  {
    name: 'init',
    description: 'Initialize a VELLOC.md file',
    kind: 'skill',
    source: 'bundled',
  },
  {
    name: 'anthropic-skills:skill-creator',
    description: 'Build a new skill iteratively',
    kind: 'skill',
    source: 'bundled',
  },
]

describe('detectSlashQuery', () => {
  it('returns "" when the composer holds just `/` — this is the regression case', () => {
    // The mention primitive in @assistant-ui/react@0.12.22 fails this
    // because its trigger detector reads stale cursor state on the
    // first character. Our manual detector must open the popover the
    // moment `/` lands.
    expect(detectSlashQuery('/')).toBe('')
  })

  it('returns the trailing query for /<word>', () => {
    expect(detectSlashQuery('/hel')).toBe('hel')
    expect(detectSlashQuery('/help')).toBe('help')
  })

  it('accepts colons and hyphens (plugin-namespaced skill ids)', () => {
    expect(detectSlashQuery('/anthropic-skills:skill-creator')).toBe(
      'anthropic-skills:skill-creator',
    )
  })

  it('triggers mid-message when the slash follows whitespace', () => {
    // Regression: the trigger used to be anchored with `^`, so a `/` typed
    // anywhere but the very start of the composer never opened the picker.
    expect(detectSlashQuery(' /help')).toBe('help')
    expect(detectSlashQuery('hello /help')).toBe('help')
    expect(detectSlashQuery('do this then /')).toBe('')
    expect(detectSlashQuery('line one\n/rev')).toBe('rev')
  })

  it('does not trigger when the slash is glued to a word', () => {
    // Otherwise every path and URL would open the popover.
    expect(detectSlashQuery('https://example.com')).toBeNull()
    expect(detectSlashQuery('src/utils')).toBeNull()
  })

  it('returns null once a space follows — popover should close', () => {
    expect(detectSlashQuery('/help ')).toBeNull()
    expect(detectSlashQuery('/model gpt-4')).toBeNull()
  })

  it('returns null for non-slash input', () => {
    expect(detectSlashQuery('')).toBeNull()
    expect(detectSlashQuery('hello world')).toBeNull()
  })

  it('matches the token at the CARET, not the end of the text', () => {
    // Caret parked inside `/help` in `/help me` → the query is the token's
    // whole word, the part after the caret included.
    expect(detectSlashQuery('/help me', 4)).toBe('help')
    // Caret past the token's trailing space → no token any more.
    expect(detectSlashQuery('/help me', 8)).toBeNull()
  })
})

describe('detectSlashToken', () => {
  it('reports where the token starts so completion can splice it', () => {
    expect(detectSlashToken('/rev', 4)).toEqual({ query: 'rev', start: 0, end: 4 })
    expect(detectSlashToken('fix this: /rev', 14)).toEqual({
      query: 'rev',
      start: 10,
      end: 14,
    })
  })

  it('locates a bare slash typed mid-message', () => {
    // Caret sits just after the `/` (index 10), i.e. offset 11.
    expect(detectSlashToken('fix this: / now', 11)).toEqual({
      query: '',
      start: 10,
      end: 11,
    })
  })
})

describe('a `/` typed in front of existing text', () => {
  // Regression: `marketplace add x`, then `/` typed at the start, offered
  // every command (the query before the caret is empty) instead of the
  // ones matching the word the slash now heads.
  it('takes the word after the caret into the query', () => {
    expect(detectSlashToken('/marketplace add x', 1)).toEqual({
      query: 'marketplace',
      start: 0,
      end: 12,
    })
    expect(detectSlashQuery('fix /rev now', 5)).toBe('rev')
  })

  it('filters by that word, not as a bare `/`', () => {
    const commands = [
      ...COMMANDS,
      { name: 'marketplace', description: 'Manage marketplaces', kind: 'builtin' as const },
    ]
    const query = detectSlashQuery('/marketplace add x', 1)!
    expect(rankCommands(commands, query).map(c => c.name)).toEqual(['marketplace'])
  })

  it('a completion replaces the whole word and keeps the arguments', () => {
    const text = '/mark add x'
    const token = detectSlashToken(text, 1)!
    expect(completeSlashToken(text, token, 'marketplace')).toBe('/marketplace add x')
    const mid = 'fix this: /rev now'
    expect(completeSlashToken(mid, detectSlashToken(mid, 14)!, 'review')).toBe(
      'fix this: /review now',
    )
    expect(completeSlashToken('/rev', detectSlashToken('/rev', 4)!, 'review')).toBe('/review ')
  })
})

describe('rankCommands', () => {
  it('returns every command when the query is empty (just-typed `/`)', () => {
    expect(rankCommands(COMMANDS, '').map(c => c.name)).toEqual(
      COMMANDS.map(c => c.name),
    )
  })

  it('ranks prefix matches first', () => {
    const results = rankCommands(COMMANDS, 'hel')
    expect(results[0]?.name).toBe('help')
  })

  it('ranks name-substring above description-substring', () => {
    // `co` is in `compact` (name substring) and in "conversation"
    // (description). Name match must win.
    const results = rankCommands(COMMANDS, 'co')
    expect(results[0]?.name).toBe('compact')
  })

  it('falls back to description matches when no name matches', () => {
    const results = rankCommands(COMMANDS, 'branch')
    expect(results.map(c => c.name)).toEqual(['review'])
  })

  it('returns nothing when no command matches', () => {
    expect(rankCommands(COMMANDS, 'xyzzy')).toEqual([])
  })

  it('handles namespaced names (prefix on the namespace prefix)', () => {
    const results = rankCommands(COMMANDS, 'anthropic')
    expect(results[0]?.name).toBe('anthropic-skills:skill-creator')
  })
})

describe('rankCommands — hidden command style', () => {
  const WITH_HIDDEN: SlashCommandSummary[] = [
    ...COMMANDS,
    {
      name: 'debug',
      description: 'Transcript diagnostics: per-segment sizes and tool stats',
      kind: 'builtin',
      hidden: true,
    },
  ]

  it('excludes hidden commands from the empty-query (just-typed `/`) list', () => {
    expect(rankCommands(WITH_HIDDEN, '').map(c => c.name)).toEqual(
      COMMANDS.map(c => c.name),
    )
  })

  it('does not surface a hidden command on a prefix / fuzzy match', () => {
    // `deb` is a strict prefix of `debug` but must NOT appear — hidden
    // commands are withheld from the auto prompt.
    expect(rankCommands(WITH_HIDDEN, 'deb')).toEqual([])
    // A description-word match must not reveal it either.
    expect(rankCommands(WITH_HIDDEN, 'diagnostics')).toEqual([])
  })

  it('surfaces a hidden command only on an exact full-name query', () => {
    const results = rankCommands(WITH_HIDDEN, 'debug')
    expect(results[0]?.name).toBe('debug')
  })

  it('lets a visible command of the same name win over the hidden one', () => {
    const shadowed: SlashCommandSummary[] = [
      {
        name: 'debug',
        description: 'A visible override',
        kind: 'skill',
        source: 'project',
      },
      ...WITH_HIDDEN,
    ]
    const results = rankCommands(shadowed, 'debug')
    // Exactly one `debug` — the visible skill — and it's not the hidden one.
    expect(results.filter(c => c.name === 'debug')).toHaveLength(1)
    expect(results[0]?.kind).toBe('skill')
  })
})

describe('buildSlashCommandSummaries — hidden-builtin/skill dedup', () => {
  function promptCommand(
    overrides: Partial<ChromiumPromptCommand> = {},
  ): ChromiumPromptCommand {
    return {
      type: 'prompt',
      name: 'demo',
      description: 'A demo skill',
      content: 'body',
      path: '/skills/demo/SKILL.md',
      loadedFrom: 'skills',
      source: 'project',
      ...overrides,
    }
  }

  it('emits exactly one `debug` entry when the bundled debug skill is loaded', () => {
    // The bundled `debug` skill shares its name with the hidden `/debug`
    // built-in dispatcher. Typed input always hits the built-in (which
    // forwards to the skill itself), so the summary list must not carry a
    // second, misleading skill-kind entry.
    const summaries = buildSlashCommandSummaries({
      isNexusHost: true,
      commands: [
        promptCommand({ name: 'debug', description: 'Diagnose the runtime' }),
        promptCommand({ name: 'review' }),
      ],
    })
    const debugEntries = summaries.filter(entry => entry.name === 'debug')
    expect(debugEntries).toHaveLength(1)
    expect(debugEntries[0]!.kind).toBe('builtin')
    expect(debugEntries[0]!.hidden).toBe(true)
    // The non-colliding skill still surfaces normally.
    expect(
      summaries.find(entry => entry.name === 'review')?.kind,
    ).toBe('skill')
  })

  it('tags a `hiddenFromPicker` skill hidden — dispatchable, not suggested', () => {
    // The hidden command style, opened to skills: the row is still in the
    // summary list (so an exact full-name query can reveal it and typing it
    // dispatches), but `rankCommands` keeps it out of the `/` suggestions.
    const summaries = buildSlashCommandSummaries({
      isNexusHost: true,
      commands: [
        promptCommand({ name: 'quiet-skill', hiddenFromPicker: true }),
        promptCommand({ name: 'loud-skill' }),
      ],
    })
    const quiet = summaries.find(entry => entry.name === 'quiet-skill')
    expect(quiet?.kind).toBe('skill')
    expect(quiet?.hidden).toBe(true)
    expect(summaries.find(entry => entry.name === 'loud-skill')?.hidden).toBeUndefined()
    expect(rankCommands(summaries, '').map(entry => entry.name)).not.toContain('quiet-skill')
    expect(rankCommands(summaries, 'quiet').map(entry => entry.name)).not.toContain('quiet-skill')
    expect(rankCommands(summaries, 'quiet-skill').map(entry => entry.name)).toContain('quiet-skill')
  })

  it('keeps model-only skills out and visible built-ins in', () => {
    const summaries = buildSlashCommandSummaries({
      isNexusHost: true,
      commands: [promptCommand({ name: 'quiet', userCallable: false })],
    })
    expect(summaries.find(entry => entry.name === 'quiet')).toBeUndefined()
    expect(summaries.find(entry => entry.name === 'help')?.kind).toBe('builtin')
    // Nexus host drops /tabs.
    expect(summaries.find(entry => entry.name === 'tabs')).toBeUndefined()
  })

  describe('buildLoadedSkillSummaries — the Skills-tab list', () => {
    it('includes model-only skills and carries each skill\'s on-disk path', () => {
      const list = buildLoadedSkillSummaries([
        promptCommand({ name: 'zeta', path: '/s/zeta/SKILL.md', source: 'user' }),
        // Excluded from the slash picker (userCallable:false), but the browse
        // list keeps it.
        promptCommand({ name: 'alpha', path: '/s/alpha/SKILL.md', userCallable: false }),
      ])
      expect(list.map(s => s.name)).toEqual(['alpha', 'zeta'])
      expect(list.find(s => s.name === 'zeta')).toMatchObject({
        path: '/s/zeta/SKILL.md',
        source: 'user',
      })
    })

    it('drops a pathless command and name-dedupes (first wins)', () => {
      const list = buildLoadedSkillSummaries([
        promptCommand({ name: 'dup', path: '/first/SKILL.md' }),
        promptCommand({ name: 'dup', path: '/second/SKILL.md' }),
        { ...promptCommand({ name: 'nopath' }), path: '' },
      ])
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ name: 'dup', path: '/first/SKILL.md' })
    })

    it('carries the UTF-8 byte length of the skill body as `size`', () => {
      // 'body' is 4 ASCII bytes; a multi-byte string proves this is a byte
      // count, not `content.length` (which would read 3 for '你好世' — three
      // UTF-16 code units, nine UTF-8 bytes).
      const list = buildLoadedSkillSummaries([
        promptCommand({ name: 'ascii', content: 'body' }),
        promptCommand({ name: 'multibyte', content: '你好世' }),
      ])
      expect(list.find(s => s.name === 'ascii')).toMatchObject({ size: 4 })
      expect(list.find(s => s.name === 'multibyte')).toMatchObject({ size: 9 })
    })

    it('maps an empty-content body to size undefined, not 0 — the dynamic-content bundled-skill placeholder', () => {
      // A dynamic-content bundled skill (e.g. /debug, /loop) registers with
      // `content: ''` — the real body is produced at invocation time. `size: 0`
      // would render a bogus "0 B" badge; the builder must say "unknown".
      const list = buildLoadedSkillSummaries([
        promptCommand({
          name: 'dyn',
          path: 'bundled:dyn',
          source: 'bundled',
          content: '',
        }),
      ])
      expect(list).toHaveLength(1)
      expect(list[0]!.size).toBeUndefined()
    })
  })
})

describe('slashCommandDescription — localized picker hints', () => {
  const builtin: SlashCommandSummary = {
    name: 'help',
    blurbKey: 'slash.builtin.help',
    kind: 'builtin',
  }
  const skill: SlashCommandSummary = {
    name: 'review',
    description: 'Review the pending changes on this branch',
    kind: 'skill',
    source: 'project',
  }

  it('translates a built-in hint into the active locale', () => {
    expect(slashCommandDescription(builtin, createTranslate('zh'))).toBe(
      zh['slash.builtin.help'],
    )
    expect(slashCommandDescription(builtin, createTranslate('en'))).toBe(
      en['slash.builtin.help'],
    )
  })

  it('passes an author-written skill description through untouched', () => {
    // Skill/plugin descriptions come from markdown frontmatter, which the app
    // has no catalog entry for. Translating them is not possible; mangling
    // them would be worse than leaving them English.
    expect(slashCommandDescription(skill, createTranslate('zh'))).toBe(
      'Review the pending changes on this branch',
    )
  })

  it('falls back rather than rendering a raw key from an unknown build', () => {
    // `t()` echoes an unknown key verbatim, so an ungated key would put a raw
    // dotted string in the picker. A worker from another build could send one.
    const stale: SlashCommandSummary = {
      name: 'ghost',
      blurbKey: 'slash.builtin.notARealKey' as MessageKey,
      description: 'legacy text',
      kind: 'builtin',
    }
    expect(slashCommandDescription(stale, createTranslate('en'))).toBe(
      'legacy text',
    )
  })

  it('ranks on the DISPLAYED text, so search works in a non-English locale', () => {
    // Without this the zh user types zh words and matches nothing: the
    // English source they cannot see would be the only searchable text.
    const commands: SlashCommandSummary[] = [
      { name: 'help', blurbKey: 'slash.builtin.help', kind: 'builtin' },
      { name: 'clear', blurbKey: 'slash.builtin.clear', kind: 'builtin' },
    ]
    const describeZh = (command: SlashCommandSummary) =>
      slashCommandDescription(command, createTranslate('zh'))

    // 「清空」 appears only in the Chinese description of /clear.
    const results = rankCommands(commands, '清空', describeZh)

    expect(results.map(c => c.name)).toEqual(['clear'])
    // And the English word no longer matches, because it is not on screen.
    expect(rankCommands(commands, 'Clear the', describeZh)).toEqual([])
  })

  it('sends keys rather than English text over the wire for built-ins', () => {
    // The worker has no locale and no business choosing one: presentation is
    // the webview's job. A built-in carrying English `description` would
    // render untranslated no matter what the picker does.
    const summaries = buildSlashCommandSummaries({
      isNexusHost: true,
      commands: [],
    })
    for (const summary of summaries) {
      expect(summary.kind).toBe('builtin')
      expect(summary.blurbKey).toBeTruthy()
      expect(summary.description).toBeUndefined()
    }
  })
})

describe('buildSlashCommandSummaries — mod commands (F-25 $.command.register)', () => {
  it('lists a mod command after the built-ins as kind mod from a plugin, outranking a skill of its name', () => {
    const summaries = buildSlashCommandSummaries({
      isNexusHost: true,
      commands: [
        {
          type: 'prompt',
          name: 'hello',
          description: 'A skill also named hello',
          content: 'body',
          path: '/skills/hello/SKILL.md',
          loadedFrom: 'skills',
          source: 'project',
        } as ChromiumPromptCommand,
      ],
      modCommands: [
        { name: 'zed', description: 'Last by name', plugin: 'tools' },
        { name: 'hello', description: 'Says hi.', argumentHint: '[name]', plugin: 'greeter' },
      ],
    })
    const names = summaries.map(entry => entry.name)
    expect(names.indexOf('hello')).toBeGreaterThan(names.indexOf('permissions'))
    expect(names.indexOf('hello')).toBeLessThan(names.indexOf('zed'))
    expect(summaries.filter(entry => entry.name === 'hello')).toEqual([
      { name: 'hello', description: 'Says hi.', kind: 'mod', source: 'plugin', argumentHint: '[name]' },
    ])
    expect(summaries.find(entry => entry.name === 'zed')).toEqual({
      name: 'zed',
      description: 'Last by name',
      kind: 'mod',
      source: 'plugin',
    })
  })

  it('never lists a mod command under a built-in\'s name (refused at registration anyway)', () => {
    const summaries = buildSlashCommandSummaries({
      isNexusHost: true,
      commands: [],
      modCommands: [{ name: 'help', description: 'mine', plugin: 'p' }],
    })
    expect(summaries.filter(entry => entry.name === 'help')).toHaveLength(1)
    expect(summaries.find(entry => entry.name === 'help')!.kind).toBe('builtin')
  })
})
