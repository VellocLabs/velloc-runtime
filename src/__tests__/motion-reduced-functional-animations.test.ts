import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Functional status indicators keep animating under reduced-motion (the release WebUI reports
 * `prefers-reduced-motion: reduce` regardless of the user): a reduced-motion block in globals.css re-enables
 * `.animate-spin` and each `.nexus-blob-*` layer.
 */

const here = dirname(fileURLToPath(import.meta.url))
const GLOBALS_CSS = readFileSync(
  join(here, '..', 'styles', 'globals.css'),
  'utf8',
)

/** Extract the bodies of every `@media (prefers-reduced-motion: reduce){...}` block. */
function reducedMotionBlocks(css: string): string[] {
  const blocks: string[] = []
  const re = /@media[^{]*prefers-reduced-motion:\s*reduce[^{]*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    // Walk braces from the opening `{` to find the matching close.
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
    }
    blocks.push(css.slice(start, i - 1))
  }
  return blocks
}

describe('reduced-motion functional-animation exemption (globals.css)', () => {
  it('re-enables .animate-spin (running spinners) under reduced-motion', () => {
    const reenabled = reducedMotionBlocks(GLOBALS_CSS).some(
      body =>
        body.includes('.animate-spin') &&
        /animation:\s*spin\b/.test(body) &&
        body.includes('!important'),
    )
    expect(
      reenabled,
      'globals.css must re-enable `.animate-spin` (with !important, to beat ' +
        'the motion-reduce:animate-none utility) inside a ' +
        'prefers-reduced-motion:reduce block so the conversation + session-list ' +
        'running spinners keep moving in the release WebUI.',
    ).toBe(true)
  })

  // The tool/todo card's "Working" header + in-progress sub-step spinner use
  // the `motion-safe:animate-spin` VARIANT (StepGlyph), which has no rule at
  // all under reduce (motion-safe only matches no-preference). It must be
  // re-asserted separately from the base `.animate-spin`, or the tool-card
  // spinners stay frozen. The ProgressBar's active pulse is the same case.
  it('re-enables .motion-safe\\:animate-spin (tool-card StepGlyph spinner) under reduced-motion', () => {
    const reenabled = reducedMotionBlocks(GLOBALS_CSS).some(
      body =>
        body.includes('.motion-safe\\:animate-spin') &&
        /animation:\s*spin\b/.test(body) &&
        body.includes('!important'),
    )
    expect(
      reenabled,
      'globals.css must re-enable `.motion-safe\\:animate-spin` inside a ' +
        'prefers-reduced-motion:reduce block — the plan/todo StepGlyph spinner ' +
        '(tool-card "Working" header + in-progress sub-step) uses that variant ' +
        'and otherwise freezes in the release WebUI.',
    ).toBe(true)
  })

  it('re-enables .motion-safe\\:animate-pulse (ProgressBar working pulse) under reduced-motion', () => {
    const reenabled = reducedMotionBlocks(GLOBALS_CSS).some(
      body =>
        body.includes('.motion-safe\\:animate-pulse') &&
        /animation:\s*pulse\b/.test(body) &&
        body.includes('!important'),
    )
    expect(
      reenabled,
      'globals.css must re-enable `.motion-safe\\:animate-pulse` inside a ' +
        'prefers-reduced-motion:reduce block so the plan/todo ProgressBar ' +
        'working pulse keeps animating in the release WebUI.',
    ).toBe(true)
  })

  // The conversation running-indicator (gooey-metaball blob) is a functional
  // "agent is working" indicator, exactly like .qs-runner / .animate-spin. Each
  // of its animated layers must be re-asserted with !important under
  // reduced-motion so the release WebUI's spurious `reduce` can't freeze it.
  const BLOB_LAYERS = [
    { cls: '.nexus-blob-orbit', anim: 'nexus-blob-spin' },
    { cls: '.nexus-blob-core', anim: 'nexus-blob-pulse' },
  ] as const

  for (const { cls, anim } of BLOB_LAYERS) {
    it(`re-enables ${cls} (running-indicator blob) under reduced-motion`, () => {
      const reenabled = reducedMotionBlocks(GLOBALS_CSS).some(
        body =>
          body.includes(cls) &&
          new RegExp(`animation:\\s*${anim}\\b`).test(body) &&
          body.includes('!important'),
      )
      expect(
        reenabled,
        `globals.css must re-enable \`${cls}\` with \`animation: ${anim} ... ` +
          '!important\` inside a prefers-reduced-motion:reduce block so the ' +
          'conversation running-indicator blob keeps animating in the release WebUI.',
      ).toBe(true)
    })
  }

  // The session-list "this thread is busy" indicator (ink drop ripple, which
  // replaced the spinning Loader2) is the same kind of functional indicator and
  // must likewise survive reduced-motion — re-asserted per nth-child so the
  // staggered delays are preserved.
  const RIPPLE_LAYERS = [
    { cls: '.nexus-ripple i', anim: 'nexus-ripple' },
  ] as const

  for (const { cls, anim } of RIPPLE_LAYERS) {
    it(`re-enables ${cls} (session-list busy ripple) under reduced-motion`, () => {
      const reenabled = reducedMotionBlocks(GLOBALS_CSS).some(
        body =>
          body.includes(cls) &&
          new RegExp(`animation:\\s*${anim}\\b`).test(body) &&
          body.includes('!important'),
      )
      expect(
        reenabled,
        `globals.css must re-enable \`${cls}\` with \`animation: ${anim} ... ` +
          '!important\` inside a prefers-reduced-motion:reduce block so the ' +
          'session-list busy ripple keeps animating in the release WebUI.',
      ).toBe(true)
    })
  }

  // (The AskUserQuestion "answer me" flash that used to be exempted here was
  // removed entirely: a pending question is hoisted to a standalone top-level
  // surface, so no flash exists to re-enable.)

  // The full-panel conversation loading page (fast arc spinner) is the same kind
  // of functional indicator and must likewise survive reduced-motion.
  const LOADPAGE_LAYERS = [
    { cls: '.nexus-loadpage-arc', anim: 'nexus-load-spin' },
    { cls: '.nexus-loadpage-label', anim: 'nexus-load-label-breathe' },
  ] as const

  for (const { cls, anim } of LOADPAGE_LAYERS) {
    it(`re-enables ${cls} (conversation loading page) under reduced-motion`, () => {
      const reenabled = reducedMotionBlocks(GLOBALS_CSS).some(
        body =>
          body.includes(cls) &&
          new RegExp(`animation:\\s*${anim}\\b`).test(body) &&
          body.includes('!important'),
      )
      expect(
        reenabled,
        `globals.css must re-enable \`${cls}\` with \`animation: ${anim} ... ` +
          '!important\` inside a prefers-reduced-motion:reduce block so the ' +
          'conversation loading page keeps animating in the release WebUI.',
      ).toBe(true)
    })
  }
})
