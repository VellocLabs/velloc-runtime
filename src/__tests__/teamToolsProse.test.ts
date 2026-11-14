import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('team prompt — one plan, one list', () => {
  /**
   * The team tool block must not present the conversation's step list as a second plan beside the SHARED task
   * list: two numbered lists get one's row numbers read as the other's ids.
   */
  it('says the step list belongs to this conversation and the shared list is the plan', () => {
    const body = readFileSync(
      path.resolve(process.cwd(), 'src/template/team/includes/team_using_your_tools.md'),
      'utf8',
    )
    expect(body).toContain('{{IF_TOOL:mcp__session_turn__set_plan}}')
    expect(body).toContain('your own progress in this conversation')
    expect(body).toContain("teammates cannot see it")
    expect(body).toContain("shared task list is the team's plan")
    // The precise failure: a row's POSITION is not a task id.
    expect(body).toContain('number their items separately')
    // The inherited line must not come back.
    expect(body).not.toContain('TodoWrite')
  })
})
