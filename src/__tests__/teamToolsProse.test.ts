import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('team prompt — one plan, one list', () => {
  /**
   * The team tool block must not tell the model to track work with TodoWrite beside the SHARED task list: two
   * lists both calling their items "task" get one's row numbers read as the other's ids.
   */
  it('says TodoWrite is private scratch and the shared list is the plan', () => {
    const body = readFileSync(
      path.resolve(process.cwd(), 'src/template/team/includes/team_using_your_tools.md'),
      'utf8',
    )
    expect(body).toContain('private scratch list for this session')
    expect(body).toContain("teammates cannot see it")
    expect(body).toContain("shared task list is the team's plan")
    // The precise failure: a row's POSITION is not a task id.
    expect(body).toContain('number their items separately')
    // The inherited line must not come back.
    expect(body).not.toContain('Plan and track work with TodoWrite')
  })
})
