// @vitest-environment happy-dom
import { createElement as h } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { buttonVariants } from '../components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../components/ui/tooltip'

afterEach(() => cleanup())

/**
 * Tooltips share the composer Send button's palette: the Send button is the
 * `default` Button variant, so a tooltip's background is that variant's
 * background and its text is that variant's foreground.
 */
describe('tooltip colors follow the composer Send button', () => {
  const sendClasses = buttonVariants({ variant: 'default' }).split(/\s+/)
  const sendBg = sendClasses.find((c) => c.startsWith('bg-'))!
  const sendFg = sendClasses.find((c) => /^text-.*foreground$/.test(c))!

  it('uses the Send button background and foreground', () => {
    render(
      h(TooltipProvider, null,
        h(Tooltip, { open: true },
          h(TooltipTrigger, null, 'trigger'),
          h(TooltipContent, null, 'tip'))),
    )
    const content = document.querySelector('[data-slot="tooltip-content"]')
    expect(content).not.toBeNull()
    const classes = content!.className.split(/\s+/)
    expect(sendBg).toBe('bg-primary')
    expect(sendFg).toBe('text-primary-foreground')
    expect(classes).toContain(sendBg)
    expect(classes).toContain(sendFg)
    expect(classes).not.toContain('bg-foreground')
    expect(classes).not.toContain('text-background')
  })
})
