import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  BackgroundResultsCard,
  NotificationEntry,
  parseTaskNotifications,
} from '../components/assistant-ui/background-results-card'

describe('BackgroundResultsCard', () => {
  it('renders a collapsed summary card by default and hides the full result until expanded', () => {
    const html = renderToStaticMarkup(
      createElement(BackgroundResultsCard, {
        kind: 'shell',
        text:
          '<task-notification>\n<task-id>b-shell-1</task-id>\n<task-type>local_bash</task-type>\n<status>completed</status>\n<summary>Background command "npm test" completed\nLONG_OUTPUT</summary>\n</task-notification>',
      }),
    )

    expect(html).toContain('data-role="background-results-card"')
    expect(html).toContain('max-w-(--thread-max-width)')
    expect(html).toContain('lucide-chevron-right')
    expect(html).not.toContain('lucide-chevron-down')
    expect(html).toContain('Background shell results')
    expect(html).toContain('1 result')
    expect(html).toContain('data-state="closed"')
    expect(html).not.toContain('LONG_OUTPUT')
  })

  it('parses task-notification XML into structured entries (no raw tags leak)', () => {
    const parsed = parseTaskNotifications(
      '<task-notification>\n<task-id>aklbwjdwg</task-id>\n<task-type>local_agent</task-type>\n<status>completed</status>\n<summary>Review Wexond adblock changes (general-purpose): ## Findings\n\nNo blocking findings.</summary>\n</task-notification>',
    )

    expect(parsed).toHaveLength(1)
    expect(parsed[0].taskId).toBe('aklbwjdwg')
    expect(parsed[0].taskType).toBe('local_agent')
    expect(parsed[0].status).toBe('completed')
    expect(parsed[0].summary).toContain('Review Wexond adblock changes')
  })

  it('renders a structured entry (task id + status badge + title) instead of raw XML', () => {
    const [notification] = parseTaskNotifications(
      '<task-notification>\n<task-id>aklbwjdwg</task-id>\n<task-type>local_agent</task-type>\n<status>completed</status>\n<summary>Review Wexond adblock changes (general-purpose): ## Findings\n\nNo blocking findings.</summary>\n</task-notification>',
    )
    const html = renderToStaticMarkup(
      createElement(NotificationEntry, { notification }),
    )

    // Structured fields are surfaced...
    expect(html).toContain('aklbwjdwg')
    expect(html).toContain('completed')
    expect(html).toContain('Review Wexond adblock changes (general-purpose)')
    // ...but the raw XML tags are NOT leaked into the render.
    expect(html).not.toContain('<task-id>')
    expect(html).not.toContain('<summary>')
  })

  it('extracts the shell command into a monospace header', () => {
    const [notification] = parseTaskNotifications(
      '<task-notification>\n<task-id>b-shell-1</task-id>\n<task-type>local_bash</task-type>\n<status>completed</status>\n<summary>Background command "npm test" completed\nall tests passed</summary>\n</task-notification>',
    )
    const html = renderToStaticMarkup(
      createElement(NotificationEntry, { notification }),
    )

    expect(html).toContain('npm test')
    expect(html).toContain('all tests passed')
    expect(html).not.toContain('Background command')
  })

  it('infers task-type from the summary when the tag is absent (imported session)', () => {
    // Imported agent and shell task notifications carry no <task-type>.
    // The parser must fall back to the summary prefix so a shell task isn't
    // mislabelled as an agent (wrong icon + title extraction).
    const [agent] = parseTaskNotifications(
      '<task-notification>\n<task-id>ac9f4e553041936c6</task-id>\n<output-file>C:/tasks/a.output</output-file>\n<status>completed</status>\n<summary>Agent "Review converter" finished</summary>\n<result>ok</result>\n</task-notification>',
    )
    expect(agent.taskType).toBe('local_agent')

    const [shell] = parseTaskNotifications(
      '<task-notification>\n<task-id>b-shell-cc</task-id>\n<output-file>C:/tasks/b.output</output-file>\n<status>completed</status>\n<summary>Background command "npm test" completed</summary>\n</task-notification>',
    )
    expect(shell.taskType).toBe('local_bash')
  })
})
