import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain .mjs build script, no type declarations
import { generatedHeaderBlocks } from '../../scripts/stage_deploy.mjs'

/**
 * The model catalog snapshot (F-28) is served at fixed URLs under each served
 * version. Its bytes change per deploy, so it must NOT fall under an immutable
 * rule: a day-long cache with edge revalidation, for the current and every
 * retained version alike.
 */
describe('catalog snapshot cache headers', () => {
  it('revalidates daily, never immutable, for every served version', () => {
    const headers: string = generatedHeaderBlocks(['v2', 'v1'])
    for (const name of ['v2', 'v1']) {
      const lines = headers.split('\n')
      const start = lines.findIndex(line => line === `/${name}/catalog/snapshot/*`)
      expect(start, `${name} snapshot rule`).toBeGreaterThanOrEqual(0)
      const body = lines.slice(start + 1, start + 3)
      expect(body).toEqual(['  ! Cache-Control', '  Cache-Control: public, max-age=86400, s-maxage=0'])
    }
  })
})
