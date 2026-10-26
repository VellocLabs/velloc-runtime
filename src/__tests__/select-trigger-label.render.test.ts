// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { Select } from '../components/ui/select'

/**
 * Select wrapper: an option's `triggerLabel` replaces its full `label` in the closed trigger, so a two-line
 * option (name + description) shows only its name; options without one show their `label` as before.
 */

afterEach(cleanup)

const twoLine = (name: string, desc: string) =>
  createElement('span', null, createElement('span', null, name), createElement('span', null, desc))

function renderSelect(value: string, withTriggerLabel: boolean) {
  render(
    createElement(Select, {
      testId: 'pick',
      value,
      onValueChange: () => {},
      options: [
        {
          value: 'stdio',
          label: twoLine('stdio', 'Local process'),
          ...(withTriggerLabel ? { triggerLabel: 'stdio' } : {}),
        },
        {
          value: 'http',
          label: twoLine('http', 'Remote server'),
          ...(withTriggerLabel ? { triggerLabel: 'http' } : {}),
        },
      ],
    }),
  )
  return screen.getByTestId('pick')
}

describe('Select triggerLabel', () => {
  it('shows only the selected option triggerLabel in the trigger', () => {
    const trigger = renderSelect('http', true)
    expect(trigger.textContent).toBe('http')
  })

  it('falls back to the option label when no triggerLabel is given', () => {
    const trigger = renderSelect('http', false)
    expect(trigger.textContent).toContain('Remote server')
  })
})
