// Pins the runtime's prompt-section renderer to the C++ `RenderPromptSection` byte for byte. The oracle is the six
// compiled-in constants (fixtures/cppPromptSectionConstants.ts); a section carries no trailing newline, so sections
// join with a single "\n" and no blank line.

import { describe, expect, it } from 'vitest'
import {
  PROMPT_SECTION_NAMES,
  renderPromptSection,
} from '../prompting/sections/promptSectionRenderer'
import {
  K_BROWSER_TOOLS_CONTENT,
  K_FILE_SHELL_TOOLS_CONTENT,
  K_PARALLELISM_CONTENT,
  K_SKILLS_CONTENT,
  K_SYSTEM_PROMPT_TOOLS_CONTENT,
  K_TASK_TRACKING_CONTENT,
} from './fixtures/cppPromptSectionConstants'

const HEADER = '# Using your tools\n\n'

const usingYourTools = (enabledToolNames: string[]) =>
  renderPromptSection({ name: 'using-your-tools', enabledToolNames }).text

describe('renderPromptSection — system-prompt-tools', () => {
  it('is kSystemPromptToolsContent verbatim, whatever the tool set', () => {
    for (const enabledToolNames of [[], ['BrowserClick'], ['Read', 'Skill']]) {
      expect(
        renderPromptSection({ name: 'system-prompt-tools', enabledToolNames }).text,
      ).toBe(K_SYSTEM_PROMPT_TOOLS_CONTENT)
    }
  })

  it('starts and ends where the C++ constant did (one trailing newline stripped)', () => {
    const text = renderPromptSection({ name: 'system-prompt-tools', enabledToolNames: [] }).text
    expect(text.startsWith('- Act, then verify.')).toBe(true)
    expect(text.endsWith('\n')).toBe(false)
  })
})

describe('renderPromptSection — using-your-tools', () => {
  it('is empty when no covered tool family is enabled (no lone parallelism trailer)', () => {
    expect(usingYourTools([])).toBe('')
    expect(usingYourTools(['Agent', 'WebFetch', 'a2ui_create_surface'])).toBe('')
  })

  it('a literal case: TodoWrite alone', () => {
    expect(usingYourTools(['TodoWrite'])).toBe(
      '# Using your tools\n' +
        '\n' +
        '## Task tracking\n' +
        '\n' +
        'Use TodoWrite for multi-step work. Mark a todo in_progress BEFORE starting it, completed IMMEDIATELY after finishing — do not batch completions. Exactly one todo should be in_progress at a time.\n' +
        '## Parallelism\n' +
        '\n' +
        K_PARALLELISM_CONTENT.slice('## Parallelism\n\n'.length),
    )
  })

  it('browser: any Browser* tool or Done', () => {
    const expected = `${HEADER}${K_BROWSER_TOOLS_CONTENT}\n${K_PARALLELISM_CONTENT}`
    expect(usingYourTools(['BrowserClick'])).toBe(expected)
    expect(usingYourTools(['BrowserNavigate', 'BrowserScreenshot'])).toBe(expected)
    expect(usingYourTools(['Done'])).toBe(expected)
  })

  it('file and shell: each of the eight file_tool / process_tool names gates it alone', () => {
    const expected = `${HEADER}${K_FILE_SHELL_TOOLS_CONTENT}\n${K_PARALLELISM_CONTENT}`
    for (const name of ['Bash', 'BashOutput', 'Edit', 'Glob', 'Grep', 'PowerShell', 'Read', 'Write']) {
      expect(usingYourTools([name]), name).toBe(expected)
    }
  })

  it('skills: Skill', () => {
    expect(usingYourTools(['Skill'])).toBe(`${HEADER}${K_SKILLS_CONTENT}\n${K_PARALLELISM_CONTENT}`)
  })

  it('everything: fixed section order regardless of input order', () => {
    const expected =
      HEADER +
      [
        K_BROWSER_TOOLS_CONTENT,
        K_FILE_SHELL_TOOLS_CONTENT,
        K_TASK_TRACKING_CONTENT,
        K_SKILLS_CONTENT,
        K_PARALLELISM_CONTENT,
      ].join('\n')
    expect(usingYourTools(['Skill', 'TodoWrite', 'Grep', 'BrowserNavigate'])).toBe(expected)
    expect(usingYourTools(['BrowserNavigate', 'Grep', 'TodoWrite', 'Skill', 'Agent'])).toBe(expected)
  })
})

describe('renderPromptSection — names', () => {
  it('knows the two section names, and renders an unknown one empty', () => {
    expect([...PROMPT_SECTION_NAMES]).toEqual(['using-your-tools', 'system-prompt-tools'])
    expect(renderPromptSection({ name: 'no-such-section', enabledToolNames: ['Read'] }).text).toBe('')
  })
})
