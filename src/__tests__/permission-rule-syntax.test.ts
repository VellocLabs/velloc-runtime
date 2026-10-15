/**
 * Behaviour spec for the permission-rule text users write (`Tool` / `Tool(content)`, `\(` `\)` `\\` escapes) and the
 * shell patterns inside `Bash(...)` / `PowerShell(...)`, pinned through inputs → outputs only.
 */
import { describe, expect, it } from 'vitest'
import {
  parseRuleText,
  formatRuleText,
  encodeRuleBody,
  decodeRuleBody,
  canonicalToolName,
} from '../permissions/ruleText'
import {
  compileCommandPattern,
  commandFitsPattern,
  globMatchesCommand,
} from '../permissions/commandPattern'
import { SPAWN_TOOL_ID } from '../toolkit/builtin/subagentLaunch'

const fits = (spec: string, command: string) => commandFitsPattern(compileCommandPattern(spec), command)

describe('rule text: parsing', () => {
  it('reads a bare tool name as a tool-wide rule', () => {
    expect(parseRuleText('Bash')).toEqual({ toolName: 'Bash' })
    expect(parseRuleText('mcp__docs__*')).toEqual({ toolName: 'mcp__docs__*' })
    expect(parseRuleText('')).toEqual({ toolName: '' })
  })

  it('splits Tool(content)', () => {
    expect(parseRuleText('Bash(npm run test:*)')).toEqual({ toolName: 'Bash', ruleContent: 'npm run test:*' })
    expect(parseRuleText('Read(./src/**)')).toEqual({ toolName: 'Read', ruleContent: './src/**' })
    expect(parseRuleText('WebFetch(domain:example.com)')).toEqual({ toolName: 'WebFetch', ruleContent: 'domain:example.com' })
  })

  it('treats empty and lone-star content as tool-wide; anything else is kept verbatim', () => {
    expect(parseRuleText('Bash()')).toEqual({ toolName: 'Bash' })
    expect(parseRuleText('Bash(*)')).toEqual({ toolName: 'Bash' })
    expect(parseRuleText('Bash( * )')).toEqual({ toolName: 'Bash', ruleContent: ' * ' })
    expect(parseRuleText('Bash(**)')).toEqual({ toolName: 'Bash', ruleContent: '**' })
    expect(parseRuleText('Bash( )')).toEqual({ toolName: 'Bash', ruleContent: ' ' })
  })

  it('unescapes \\( \\) and \\\\ inside content', () => {
    expect(parseRuleText('Bash(python -c "print\\(1\\)")')).toEqual({ toolName: 'Bash', ruleContent: 'python -c "print(1)"' })
    expect(parseRuleText('Bash(echo \\(hi\\))')).toEqual({ toolName: 'Bash', ruleContent: 'echo (hi)' })
    expect(parseRuleText('Bash(foo\\\\)')).toEqual({ toolName: 'Bash', ruleContent: 'foo\\' })
    expect(parseRuleText('Bash(a\\b)')).toEqual({ toolName: 'Bash', ruleContent: 'a\\b' })
  })

  it('keeps unescaped inner parentheses: the first ( and the last ) delimit', () => {
    expect(parseRuleText('Bash(a(b)c)')).toEqual({ toolName: 'Bash', ruleContent: 'a(b)c' })
    expect(parseRuleText('Bash((x))')).toEqual({ toolName: 'Bash', ruleContent: '(x)' })
    expect(parseRuleText('A\\(B(x)')).toEqual({ toolName: 'A\\(B', ruleContent: 'x' })
  })

  it('keeps newlines inside content', () => {
    expect(parseRuleText('Bash(a\nb)')).toEqual({ toolName: 'Bash', ruleContent: 'a\nb' })
  })

  it('degrades malformed text to a bare tool name holding the whole string', () => {
    for (const text of [
      'Bash(foo', // no closing paren
      'Bash(foo)x', // closing paren not last
      'Bash)foo(', // close before open
      '(foo)', // no tool name
      '()',
      'Bash\\(foo\\)', // both parens escaped
      'Bash(foo\\)', // closing paren escaped
      'Bash(foo\\\\\\)', // odd backslash run before )
    ]) {
      expect(parseRuleText(text)).toEqual({ toolName: text })
    }
  })

  it('maps the legacy Task tool name to the agent tool', () => {
    expect(canonicalToolName('Task')).toBe(SPAWN_TOOL_ID)
    expect(canonicalToolName('Agent')).toBe('Agent')
    expect(canonicalToolName('task')).toBe('task')
    expect(parseRuleText('Task')).toEqual({ toolName: SPAWN_TOOL_ID })
    expect(parseRuleText('Task()')).toEqual({ toolName: SPAWN_TOOL_ID })
    expect(parseRuleText('Task(Explore)')).toEqual({ toolName: SPAWN_TOOL_ID, ruleContent: 'Explore' })
    // Malformed: the whole string is the name, and it is not 'Task'.
    expect(parseRuleText('Task(')).toEqual({ toolName: 'Task(' })
  })
})

describe('rule text: formatting and escaping', () => {
  it('formats tool-wide rules as the bare name', () => {
    expect(formatRuleText({ toolName: 'Bash' })).toBe('Bash')
    expect(formatRuleText({ toolName: 'Bash', ruleContent: '' })).toBe('Bash')
  })

  it('escapes backslashes and parentheses in content', () => {
    expect(formatRuleText({ toolName: 'Bash', ruleContent: 'npm run test:*' })).toBe('Bash(npm run test:*)')
    expect(formatRuleText({ toolName: 'Bash', ruleContent: 'a(b)\\c' })).toBe('Bash(a\\(b\\)\\\\c)')
  })

  it('does not rename tools when formatting', () => {
    expect(formatRuleText({ toolName: 'Task', ruleContent: 'x' })).toBe('Task(x)')
  })

  it('encodes and decodes content', () => {
    expect(encodeRuleBody('')).toBe('')
    expect(encodeRuleBody('plain')).toBe('plain')
    expect(encodeRuleBody('\\')).toBe('\\\\')
    expect(encodeRuleBody('f(x)')).toBe('f\\(x\\)')
    expect(encodeRuleBody('\\(')).toBe('\\\\\\(')
    expect(decodeRuleBody('f\\(x\\)')).toBe('f(x)')
    expect(decodeRuleBody('\\\\')).toBe('\\')
    expect(decodeRuleBody('\\\\(')).toBe('\\(')
    expect(decodeRuleBody('\\\\\\\\(')).toBe('\\\\(')
    expect(decodeRuleBody('\\\\\\)')).toBe('\\)')
    expect(decodeRuleBody('a\\b')).toBe('a\\b')
    expect(decodeRuleBody('trail\\')).toBe('trail\\')
  })

  it('round-trips content through format → parse', () => {
    for (const content of [
      'npm install',
      'python -c "print(1)"',
      'C:\\Users\\me\\*',
      '\\',
      '\\\\(',
      ')(',
      '((',
      'a)',
      'echo \\* *',
      'x\ny',
      '**',
    ]) {
      expect(decodeRuleBody(encodeRuleBody(content))).toBe(content)
      expect(parseRuleText(formatRuleText({ toolName: 'Bash', ruleContent: content }))).toEqual({
        toolName: 'Bash',
        ruleContent: content,
      })
    }
    // A lone star formats fine but reads back as tool-wide.
    expect(parseRuleText(formatRuleText({ toolName: 'Bash', ruleContent: '*' }))).toEqual({ toolName: 'Bash' })
  })
})

describe('shell command patterns', () => {
  it('legacy `head:*` matches the head alone or followed by a space', () => {
    expect(fits('npm:*', 'npm')).toBe(true)
    expect(fits('npm:*', 'npm install')).toBe(true)
    expect(fits('npm:*', '  npm install  ')).toBe(true)
    expect(fits('npm:*', 'npmx')).toBe(false)
    expect(fits('npm:*', 'npm\tinstall')).toBe(false)
    expect(fits('npm run test:*', 'npm run test -- --watch')).toBe(true)
    expect(fits('npm run test:*', 'npm run testing')).toBe(false)
  })

  it('legacy head is everything before the final `:*`, stars included', () => {
    expect(fits('a:*:*', 'a:*')).toBe(true)
    expect(fits('a:*:*', 'a:* b')).toBe(true)
    expect(fits('a:*:*', 'a b')).toBe(false)
    expect(fits('npm run *:*', 'npm run * x')).toBe(true)
    expect(fits('npm run *:*', 'npm run build')).toBe(false)
  })

  it('`:*` alone, or a head containing a line break, is a literal command', () => {
    expect(fits(':*', ':*')).toBe(true)
    expect(fits(':*', ':')).toBe(false)
    expect(fits(':*', ': x')).toBe(false)
    expect(fits('a\nb:*', 'a\nb:*')).toBe(true)
    expect(fits('a\nb:*', 'a\nb')).toBe(false)
    expect(fits('a\nb:*', 'a\nb x')).toBe(false)
  })

  it('a spec without unescaped stars is an exact command (both sides trimmed)', () => {
    expect(fits('npm install', 'npm install')).toBe(true)
    expect(fits('npm install', '  npm install ')).toBe(true)
    expect(fits(' npm install ', 'npm install')).toBe(true)
    expect(fits('npm install', 'npm install foo')).toBe(false)
    expect(fits('npm install', 'npm  install')).toBe(false)
    expect(fits('', '   ')).toBe(true)
    // An escaped star keeps the spec exact, and the backslash stays literal.
    expect(fits('echo \\*', 'echo \\*')).toBe(true)
    expect(fits('echo \\*', 'echo *')).toBe(false)
    expect(fits('echo \\*', 'echo hi')).toBe(false)
  })

  it('a single trailing ` *` makes the arguments optional', () => {
    expect(fits('git *', 'git')).toBe(true)
    expect(fits('git *', 'git add')).toBe(true)
    expect(fits('git *', 'git  add .')).toBe(true)
    expect(fits('git *', 'gitx')).toBe(false)
    expect(fits('git *', 'git\tadd')).toBe(false)
    expect(fits('  git *  ', 'git')).toBe(true)
    expect(fits('echo \\* *', 'echo *')).toBe(true)
    expect(fits('echo \\* *', 'echo * hi')).toBe(true)
    expect(fits('echo \\* *', 'echo x hi')).toBe(false)
  })

  it('with two or more stars the tail is not optional', () => {
    expect(fits('git * *', 'git a b')).toBe(true)
    expect(fits('git * *', 'git a')).toBe(false)
    expect(fits('git * *', 'git')).toBe(false)
    expect(fits('git * *', 'git  ')).toBe(false) // the command is trimmed to 'git'
    expect(globMatchesCommand('git * *', 'git  ')).toBe(true)
  })

  it('a star matches any run, including empty and line breaks', () => {
    expect(fits('git*', 'git')).toBe(true)
    expect(fits('git*', 'gitx')).toBe(true)
    expect(fits('git * --force', 'git push --force')).toBe(true)
    expect(fits('git * --force', 'git  --force')).toBe(true)
    expect(fits('git * --force', 'git --force')).toBe(false)
    expect(fits('git * --force', 'git push --force-with-lease')).toBe(false)
    expect(fits('* --version', 'node --version')).toBe(true)
    expect(fits('echo *', 'echo a\nb')).toBe(true)
    expect(fits('*', 'anything at all')).toBe(true)
    expect(fits('a*b*c', 'abc')).toBe(true)
    expect(fits('a*b*c', 'axxbyyc')).toBe(true)
    expect(fits('a*b*c', 'acb')).toBe(false)
    expect(fits('a*a', 'a')).toBe(false)
    expect(fits('a*a', 'aa')).toBe(true)
    expect(fits('echo *', 'echo 日本')).toBe(true)
  })

  it('treats every other character literally', () => {
    expect(fits('ls (a|b).txt *', 'ls (a|b).txt -l')).toBe(true)
    expect(fits('ls (a|b).txt *', 'ls a.txt -l')).toBe(false)
    expect(fits('ls a.txt *', 'ls aXtxt -l')).toBe(false)
    expect(fits('echo $HOME ^[x]{2}+? *', 'echo $HOME ^[x]{2}+? y')).toBe(true)
    expect(fits(`say "hi" 'there' *`, `say "hi" 'there' now`)).toBe(true)
    expect(fits('a\\b*', 'a\\bc')).toBe(true) // lone backslash is literal
    expect(fits('a*\\', 'ab\\')).toBe(true) // trailing backslash is literal
    expect(fits('a*\\', 'ab')).toBe(false)
    expect(fits('\\\\*', '\\foo')).toBe(true) // \\ is one literal backslash
    expect(fits('\\\\*', 'foo')).toBe(false)
    expect(fits('x\\\\\\* *', 'x\\* y')).toBe(true)
    expect(fits('Git *', 'git add')).toBe(false)
  })

  it('glob matching trims the pattern but not the command', () => {
    expect(globMatchesCommand('git *', 'git add')).toBe(true)
    expect(globMatchesCommand('  git *  ', 'git')).toBe(true)
    expect(globMatchesCommand('git *', ' git add')).toBe(false)
    expect(globMatchesCommand('git *', 'git add ')).toBe(true)
    expect(globMatchesCommand('git *', 'git ')).toBe(true)
  })
})
