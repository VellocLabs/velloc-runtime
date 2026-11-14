import { describe, expect, it } from 'vitest'
import { extractBackgroundShellArgsPreview } from '../utils/toolCallDetails'
import {
  formatBackgroundShellToolLabel,
  formatSuperEditToolLabel,
  formatToolLabel,
  toolCallDescription,
  toolDisplayName,
  toolLabelArgsMissing,
  toolUseSummary,
} from '../utils/toolLabels'

/**
 * The transcript used to show the RAW tool id (Grep, Glob, Bash, WebSearch …)
 * as a call's title. These assert the humanized labels, derived
 * renderer-side from the tool name and its input. Regression guard: without src/utils/toolLabels every case here
 * fell through to the bare tool name.
 */
describe('formatToolLabel', () => {
  it('renders Grep as a Search with the quoted pattern (and path when present)', () => {
    expect(formatToolLabel('Grep', { pattern: 'useEffect' })).toBe(
      'Search: "useEffect"',
    )
    expect(formatToolLabel('Grep', { pattern: 'useEffect', path: 'src' })).toBe(
      'Search: "useEffect" in src',
    )
  })

  it('renders Glob as a Search with the raw glob pattern', () => {
    expect(formatToolLabel('Glob', { pattern: '**/*.tsx', path: 'src' })).toBe(
      'Search: **/*.tsx in src',
    )
  })

  it('renders foreground Bash / PowerShell with their command', () => {
    expect(formatToolLabel('Bash', { command: 'npm install' })).toBe(
      'Bash: npm install',
    )
    expect(
      formatToolLabel('PowerShell', { command: 'Get-ChildItem' }),
    ).toBe('PowerShell: Get-ChildItem')
  })

  it('prefers the call description over the command on a shell row', () => {
    expect(
      formatToolLabel('Bash', {
        command: 'git diff --stat main | tail -1',
        description: 'Summarise how much the branch differs from main',
      }),
    ).toBe('Bash: Summarise how much the branch differs from main')
    expect(
      formatToolLabel('PowerShell', {
        command: 'Get-ChildItem -Recurse',
        description: 'List every file under the project',
      }),
    ).toBe('PowerShell: List every file under the project')
    expect(
      formatBackgroundShellToolLabel('Bash', {
        command: 'npm run dev',
        description: 'Start the dev server',
        run_in_background: true,
      }),
    ).toBe('Bash: Start the dev server')
  })

  it('falls back to the command when the description is absent or blank', () => {
    expect(
      formatToolLabel('Bash', { command: 'npm test', description: '   ' }),
    ).toBe('Bash: npm test')
    expect(
      formatToolLabel('Bash', { command: 'npm test', description: null }),
    ).toBe('Bash: npm test')
    expect(
      formatBackgroundShellToolLabel('PowerShell', { command: 'dir' }),
    ).toBe('PowerShell: dir')
  })

  it('shows a description in the tense it is given, never the command', () => {
    const args = { command: 'rg -n TODO src', description: 'Find the open TODOs' }
    expect(formatToolLabel('Bash', args, 'progressive')).toBe(
      'Bash: Finding the open TODOs',
    )
    expect(formatToolLabel('Bash', args, 'past')).toBe('Bash: Found the open TODOs')
    expect(formatToolLabel('Bash', args)).toBe('Bash: Find the open TODOs')
    expect(formatToolLabel('Bash', { command: 'run it' }, 'past')).toBe(
      'Bash: run it',
    )
    expect(
      formatToolLabel('SuperShell', { description: 'Rebuild the index' }, 'past'),
    ).toBe('Super Shell: Rebuilt the index')
    expect(
      formatSuperEditToolLabel({ description: 'Rename the helper' }, 'progressive'),
    ).toBe('Super Edit: Renaming the helper')
    expect(
      formatBackgroundShellToolLabel(
        'PowerShell',
        { command: 'npm run dev', description: 'Start the dev server' },
        'progressive',
      ),
    ).toBe('PowerShell: Starting the dev server')
    expect(
      toolCallDescription('Bash', { description: 'Commit and push' }, 'past'),
    ).toBe('Committed and pushed')
  })

  it('reads a call description only from the tools that carry one', () => {
    expect(toolCallDescription('Bash', { description: '  Run it  ' })).toBe('Run it')
    expect(toolCallDescription('PowerShell', { description: 'Run it' })).toBe('Run it')
    expect(toolCallDescription('SuperShell', { description: 'Run it' })).toBe('Run it')
    expect(toolCallDescription('SuperEdit', { description: 'Edit it' })).toBe('Edit it')
    expect(toolCallDescription('Bash', { command: 'ls' })).toBe('')
    expect(toolCallDescription('Agent', { description: 'Explore' })).toBe('')
    expect(toolCallDescription(undefined, { description: 'x' })).toBe('')
  })

  it('keeps a shell description in the slim args a row is stored with', () => {
    expect(
      extractBackgroundShellArgsPreview(
        { command: 'npm test', description: 'Run the test suite', timeout: 5 },
        { includeForeground: true },
      ),
    ).toEqual({ command: 'npm test', description: 'Run the test suite' })
    expect(
      extractBackgroundShellArgsPreview(
        { command: 'npm test', description: '' },
        { includeForeground: true },
      ),
    ).toEqual({ command: 'npm test' })
  })

  it('renders Write / WebSearch / WebFetch / TodoWrite readably', () => {
    expect(formatToolLabel('Write', { file_path: 'src/a/newfile.ts' })).toBe(
      'Write: newfile.ts',
    )
    expect(formatToolLabel('WebSearch', { query: 'opus pricing' })).toBe(
      'Web search: "opus pricing"',
    )
    expect(
      formatToolLabel('WebFetch', { url: 'https://anthropic.com/pricing' }),
    ).toBe('Fetch: anthropic.com/pricing')
    expect(
      formatToolLabel('TodoWrite', { todos: [{}, {}, {}] }),
    ).toBe('Update todos: 3 items')
    expect(formatToolLabel('TodoWrite', { todos: [{}] })).toBe(
      'Update todos: 1 item',
    )
  })

  it('shows friendly names for the plan tools, not their raw ids', () => {
    // Regression: plan tool calls rendered their opaque function ids
    // ("ExitPlanMode" / "EnterPlanMode") in transcript rows; nexus now shows
    // friendly names.
    expect(formatToolLabel('ExitPlanMode', { plan: '# My plan' })).toBe('Plan')
    expect(formatToolLabel('EnterPlanMode', {})).toBe('Enter plan mode')
  })

  it('distinguishes an Edit from a Create by empty old_string', () => {
    expect(toolDisplayName('Edit', { old_string: 'a', new_string: 'b' })).toBe(
      'Edit',
    )
    expect(toolDisplayName('Edit', { old_string: '', new_string: 'b' })).toBe(
      'Create',
    )
  })

  it('keeps the bespoke Agent and browser_actions shapes', () => {
    expect(
      formatToolLabel('Agent', { subagent_type: 'Explore', description: 'probe' }),
    ).toBe('Sub-agent (Explore): probe')
    expect(
      formatToolLabel('browser_actions', {
        actions: [{ type: 'create_tab' }, { type: 'click_tab' }],
      }),
    ).toBe('create tab - click tab')
  })

  it('falls back to the raw name for unknown tools and empty args', () => {
    expect(formatToolLabel('SomeFutureTool', { foo: 1 })).toBe('SomeFutureTool')
    // Missing the summary field → name only, never "Name: ".
    expect(formatToolLabel('Grep', {})).toBe('Search')
    expect(toolUseSummary('Grep', {})).toBe('')
  })
})

describe('formatSuperEditToolLabel', () => {
  it('labels a SuperEdit call Super Edit: <description>', () => {
    expect(formatSuperEditToolLabel({ description: 'Rename files' })).toBe(
      'Super Edit: Rename files',
    )
  })

  it('falls back to bare Super Edit with no description (and never leaks code)', () => {
    // The slim preview keeps only `description`; even given raw args the label
    // must not render the JS source.
    expect(formatSuperEditToolLabel({ code: 'return 1' })).toBe('Super Edit')
    expect(formatSuperEditToolLabel({})).toBe('Super Edit')
  })
})

describe('WorkspaceDiff label', () => {
  it('renders WorkspaceDiff with the filename when a path is present', () => {
    expect(toolDisplayName('WorkspaceDiff')).toBe('WorkspaceDiff')
    expect(formatToolLabel('WorkspaceDiff', { path: 'src/deep/a.ts' })).toBe(
      'WorkspaceDiff: a.ts',
    )
  })

  it('renders bare WorkspaceDiff for a whole-workspace call', () => {
    expect(formatToolLabel('WorkspaceDiff', {})).toBe('WorkspaceDiff')
    expect(formatToolLabel('WorkspaceDiff', undefined)).toBe('WorkspaceDiff')
  })
})

describe('SuperShell label', () => {
  it('renders "Super Shell: <description>", or bare "Super Shell"', () => {
    expect(toolDisplayName('SuperShell')).toBe('Super Shell')
    expect(formatToolLabel('SuperShell', { description: 'Typecheck and test', code: 'x' })).toBe(
      'Super Shell: Typecheck and test',
    )
    expect(formatToolLabel('SuperShell', {})).toBe('Super Shell')
  })

  it('a row missing its description recovers the label from the sidecar', () => {
    expect(toolLabelArgsMissing('SuperShell', {})).toBe(true)
    expect(toolLabelArgsMissing('SuperShell', { description: 'd' })).toBe(false)
  })
})

describe('SendMessage label', () => {
  it('names the RECIPIENT on the one-line row, never the message body', () => {
    // The card is one line and the body renders behind the ">" expand, so the
    // label carries `to` and nothing else. `message` is heavy and must not
    // leak into a title that is rendered for every row in the transcript.
    expect(
      formatToolLabel('SendMessage', {
        to: 'worker-a',
        message: 'Rebase onto main and re-run the suite',
        team: 't1',
      }),
    ).toBe('SendMessage: worker-a')
    expect(
      formatToolLabel('SendMessage', { to: 'worker-a', message: 'x' }),
    ).not.toContain('Rebase')
  })

  it('falls back to the bare name when the recipient is absent', () => {
    expect(formatToolLabel('SendMessage', {})).toBe('SendMessage')
    expect(toolDisplayName('SendMessage')).toBe('SendMessage')
  })

  it('a historical row missing `to` recovers the label from the sidecar', () => {
    // Sanitization happens at PERSIST time, so a session written before the
    // `{ to }` slim preview existed has its args stripped whole. Without a
    // LABEL_ARG_FIELDS entry those rows would sit at a bare "SendMessage"
    // forever — the recurring "bare tool name" bug, one tool at a time.
    expect(toolLabelArgsMissing('SendMessage', {})).toBe(true)
    expect(toolLabelArgsMissing('SendMessage', undefined)).toBe(true)
    expect(toolLabelArgsMissing('SendMessage', { to: 'worker-a' })).toBe(false)
  })
})

describe('toolLabelArgsMissing — the sidecar label-recovery gate', () => {
  it('flags label-bearing tools whose identifying field is absent', () => {
    expect(toolLabelArgsMissing('Read', {})).toBe(true)
    expect(toolLabelArgsMissing('Read', undefined)).toBe(true)
    expect(toolLabelArgsMissing('SuperEdit', { code: 'x' })).toBe(true)
    expect(toolLabelArgsMissing('Grep', {})).toBe(true)
    expect(toolLabelArgsMissing('Bash', {})).toBe(true)
    expect(toolLabelArgsMissing('WorkspaceDiff', {})).toBe(true)
  })

  it('is satisfied by the slim preview field', () => {
    expect(toolLabelArgsMissing('Read', { file_path: '/a.ts' })).toBe(false)
    expect(toolLabelArgsMissing('SuperEdit', { description: 'd' })).toBe(false)
    expect(toolLabelArgsMissing('Grep', { pattern: 'x' })).toBe(false)
    expect(toolLabelArgsMissing('WorkspaceDiff', { path: 'a' })).toBe(false)
  })

  it('never flags tools whose label ignores args (nothing to recover)', () => {
    expect(toolLabelArgsMissing('TodoWrite', {})).toBe(false)
    expect(toolLabelArgsMissing('EnterPlanMode', {})).toBe(false)
    expect(toolLabelArgsMissing('some_unknown_tool', {})).toBe(false)
  })
})
