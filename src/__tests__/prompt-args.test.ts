import { describe, expect, it } from 'vitest'
import { declaredArgLabels, fillPromptArgs, splitArgString } from '../utils/promptArgs'

// Behaviour pins for skill / command argument placeholders. The placeholder
// syntax ($ARGUMENTS, $ARGUMENTS[n], $n, $label) is what authors write and
// must not change.
const fill = (
  template: string,
  raw: string | undefined,
  opts: { appendWhenUnused?: boolean; labels?: string[] } = {},
) => fillPromptArgs(template, raw, opts)

describe('splitArgString', () => {
  it('returns nothing for empty or blank input', () => {
    expect(splitArgString('')).toEqual([])
    expect(splitArgString(' \t\n ')).toEqual([])
  })

  it('splits on any whitespace run', () => {
    expect(splitArgString('a  b\tc\nd')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('groups quoted text and drops the quote characters', () => {
    expect(splitArgString(`one "two three" 'four five'`)).toEqual([
      'one',
      'two three',
      'four five',
    ])
    expect(splitArgString('pre"mid dle"post')).toEqual(['premid dlepost'])
  })

  it('keeps the other quote kind literal inside a quoted run', () => {
    expect(splitArgString(`"it's" 'say "hi"'`)).toEqual([`it's`, 'say "hi"'])
  })

  it('keeps an empty quoted token', () => {
    expect(splitArgString(`a "" b ''`)).toEqual(['a', '', 'b', ''])
  })

  it('passes backslashes and dollar signs through untouched', () => {
    expect(splitArgString('a\\ b $HOME')).toEqual(['a\\', 'b', '$HOME'])
  })

  it('falls back to a plain whitespace split on an unbalanced quote', () => {
    expect(splitArgString(`x "y z`)).toEqual(['x', '"y', 'z'])
    expect(splitArgString(` it's here `)).toEqual(["it's", 'here'])
  })
})

describe('declaredArgLabels', () => {
  it('returns nothing for missing input', () => {
    expect(declaredArgLabels(undefined)).toEqual([])
    expect(declaredArgLabels('')).toEqual([])
    expect(declaredArgLabels([])).toEqual([])
  })

  it('splits a string on whitespace and drops numeric-only labels', () => {
    expect(declaredArgLabels('alpha 12 beta\tgamma')).toEqual([
      'alpha',
      'beta',
      'gamma',
    ])
    expect(declaredArgLabels(' lead trail ')).toEqual(['lead', 'trail'])
  })

  it('filters an array without trimming the kept entries', () => {
    expect(declaredArgLabels(['a', '', '  ', '42', ' b ', 'c1'])).toEqual([
      'a',
      ' b ',
      'c1',
    ])
    expect(declaredArgLabels(['x', 7 as unknown as string, 'y'])).toEqual(['x', 'y'])
  })
})

describe('placeholder filling', () => {
  it('leaves the template alone when no argument string is given', () => {
    expect(fill('Body $0 $ARGUMENTS', undefined)).toBe('Body $0 $ARGUMENTS')
    expect(fill('Body $0', null as unknown as undefined)).toBe('Body $0')
  })

  it('fills $ARGUMENTS with the raw string, every occurrence', () => {
    expect(fill('[$ARGUMENTS] [$ARGUMENTS]', ' a  "b c" ')).toBe(
      '[ a  "b c" ] [ a  "b c" ]',
    )
  })

  it('fills indexed forms from the split tokens, blank when missing', () => {
    expect(fill('$ARGUMENTS[0]/$ARGUMENTS[1]/$ARGUMENTS[5]', 'x "y z"')).toBe('x/y z/')
    expect(fill('$0-$1-$2', 'p q')).toBe('p-q-')
    expect(fill('$01', 'p q')).toBe('q')
  })

  it('does not treat $n followed by a word character as a placeholder', () => {
    expect(fill('$1a $1_ $1', 'p q', { appendWhenUnused: false })).toBe('$1a $1_ q')
  })

  it('fills named labels by position, respecting word boundaries', () => {
    expect(
      fill('$who likes $what; $whoever $who[0] $what.', 'Ada "green tea"', {
        labels: ['who', 'what'],
      }),
    ).toBe('Ada likes green tea; $whoever $who[0] green tea.')
    expect(fill('$a $b', 'only', { labels: ['a', 'b'] })).toBe('only ')
  })

  it('mixes every placeholder form in one template', () => {
    expect(
      fill('cmd $0 $ARGUMENTS[1] $name (full=$ARGUMENTS)', 'a b', {
        labels: ['name'],
        appendWhenUnused: false,
      }),
    ).toBe('cmd a b a (full=a b)')
  })

  it('skips empty labels but keeps positions', () => {
    expect(fill('$x $y', 'one two', { labels: ['', 'y'] })).toBe('$x two')
  })

  it('treats regex metacharacters in labels literally', () => {
    expect(fill('v: $foo(bar) end', 'hi', { labels: ['foo(bar)'] })).toBe('v: hi end')
    expect(fill('start $( end', 'X', { labels: ['('] })).toBe('start X end')
    expect(fill('$foobar', 'V', { labels: ['foo(bar)'], appendWhenUnused: false })).toBe(
      '$foobar',
    )
    expect(fill('x $a.b*c+d?[e] y', 'V', { labels: ['a.b*c+d?[e]'] })).toBe('x V y')
  })

  it('applies labels, then indexed, then positional, then $ARGUMENTS in order', () => {
    // A label value that itself looks like a placeholder is expanded by the
    // later passes.
    expect(fill('$first', 'x$1 second', { labels: ['first'] })).toBe('xsecond')
    expect(fill('$first', '$ARGUMENTS[1] b', { labels: ['first'] })).toBe('b')
    expect(fill('$first', '"$1" second', { labels: ['first'] })).toBe('second')
    expect(fill('$0', '$ARGUMENTS')).toBe('$ARGUMENTS')
  })

  it('appends the raw string when nothing changed', () => {
    expect(fill('Plain body.', 'extra stuff')).toBe('Plain body.\n\nARGUMENTS: extra stuff')
    expect(fill('Plain.', '   ')).toBe('Plain.\n\nARGUMENTS:    ')
    expect(fill('', 'z')).toBe('\n\nARGUMENTS: z')
  })

  it('does not append for an empty string or when appending is off', () => {
    expect(fill('Plain.', '')).toBe('Plain.')
    expect(fill('Plain.', 'x', { appendWhenUnused: false })).toBe('Plain.')
  })

  it('still appends when a placeholder was filled with its own text', () => {
    expect(fill('$0', '$0')).toBe('$0\n\nARGUMENTS: $0')
  })

  it('does not append when a placeholder changed the text', () => {
    expect(fill('Run $ARGUMENTS', 'it')).toBe('Run it')
    expect(fill('Run $3', 'a')).toBe('Run ')
  })

  it('expands replacement patterns in the raw string for label and $ARGUMENTS fills', () => {
    expect(fill('$ARGUMENTS', 'cost $$5')).toBe('cost $5')
    expect(fill('<$v>', 'a$&b', { labels: ['v'] })).toBe('<a$vb>')
    // Indexed fills insert the token as-is.
    expect(fill('$0', 'a$&b')).toBe('a$&b')
  })
})
