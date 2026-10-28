import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// @ts-expect-error — plain .mjs build script, no types
import { DEFAULT_RATIO, directoryBytes, planKeepOnly, planPrune } from '../../scripts/prune_artifacts.mjs'

/**
 * Candidate storage pruning (G-3): before Workflow A uploads a candidate, the
 * oldest candidates are deleted once storage would pass 70% of the quota; after
 * beta serves the new candidate, every older one is deleted.
 */

const MB = 1_000_000

interface Artifact {
  id: number
  name: string
  size_in_bytes: number
  expired: boolean
  created_at: string
  workflow_run: { id: number } | null
}

let nextId = 1
function artifact(day: number, sizeMb: number, extra: Partial<Artifact> = {}): Artifact {
  const id = nextId++
  return {
    id,
    name: 'candidate',
    size_in_bytes: sizeMb * MB,
    expired: false,
    created_at: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`,
    workflow_run: { id: 1000 + id },
    ...extra,
  }
}

const ids = (list: Artifact[]) => list.map(a => a.id)

describe('planPrune', () => {
  it('deletes nothing while live plus incoming fits the budget', () => {
    const plan = planPrune({
      artifacts: [artifact(1, 200), artifact(2, 200)],
      quotaBytes: 1000 * MB, incomingBytes: 200 * MB,
    })
    expect(DEFAULT_RATIO).toBe(0.7)
    expect(plan.budgetBytes).toBe(700 * MB)
    expect(plan.deletions).toEqual([])
    expect(plan.overBudget).toBe(false)
  })

  it('deletes the oldest first, and only as many as the budget needs', () => {
    const oldest = artifact(1, 200)
    const middle = artifact(5, 200)
    const recent = artifact(9, 200)
    const newest = artifact(12, 200)
    // Out of order on purpose: the API order is not a creation order.
    const plan = planPrune({
      artifacts: [recent, newest, oldest, middle],
      quotaBytes: 1000 * MB, incomingBytes: 200 * MB,
    })
    // 800 live + 200 incoming = 1000; two deletions bring it to 600 ≤ 700.
    expect(ids(plan.deletions)).toEqual([oldest.id, middle.id])
    expect(plan.projectedBytes).toBe(600 * MB)
    expect(plan.overBudget).toBe(false)
  })

  it('never deletes the newest candidate or a kept run, and reports what still does not fit', () => {
    const served = artifact(1, 300)
    const old = artifact(2, 300)
    const newest = artifact(3, 300)
    const plan = planPrune({
      artifacts: [served, old, newest],
      quotaBytes: 500 * MB, incomingBytes: 300 * MB,
      keepRunIds: [String(served.workflow_run!.id), ''],
    })
    expect(ids(plan.deletions)).toEqual([old.id])
    expect(plan.overBudget).toBe(true)
    expect(plan.projectedBytes).toBe(900 * MB)
  })

  it('counts other artifacts toward the total but never deletes them, and ignores expired ones', () => {
    const report = artifact(1, 300, { name: 'test-report' })
    const gone = artifact(2, 900, { expired: true })
    const old = artifact(3, 200)
    const orphan = artifact(4, 200, { workflow_run: null })
    const newest = artifact(5, 100)
    const plan = planPrune({
      artifacts: [report, gone, old, orphan, newest],
      quotaBytes: 1000 * MB, incomingBytes: 100 * MB,
    })
    // 800 live (the expired 900 holds nothing) + 100 incoming = 900.
    expect(plan.liveBytes).toBe(800 * MB)
    expect(ids(plan.deletions)).toEqual([old.id])
    expect(plan.projectedBytes).toBe(700 * MB)
  })

  it('rejects a missing quota or an out-of-range ratio', () => {
    expect(() => planPrune({ artifacts: [], quotaBytes: Number.NaN })).toThrow(/quotaBytes/)
    expect(() => planPrune({ artifacts: [], quotaBytes: MB, ratio: 0 })).toThrow(/ratio/)
    expect(() => planPrune({ artifacts: [], quotaBytes: MB, ratio: 1.5 })).toThrow(/ratio/)
  })
})

describe('planKeepOnly', () => {
  it('deletes every live candidate outside the kept runs, oldest first', () => {
    const later = artifact(7, 200)
    const orphan = artifact(3, 200, { workflow_run: null })
    const kept = artifact(9, 200)
    const report = artifact(1, 50, { name: 'test-report' })
    const gone = artifact(2, 200, { expired: true })
    const plan = planKeepOnly({
      artifacts: [later, kept, report, orphan, gone],
      keepRunIds: [String(kept.workflow_run!.id)],
    })
    expect(ids(plan.deletions)).toEqual([orphan.id, later.id])
  })

  it('refuses to run without a kept run, so it can never delete every candidate', () => {
    expect(() => planKeepOnly({ artifacts: [artifact(1, 10)], keepRunIds: [] })).toThrow(/--keep-run/)
    expect(() => planKeepOnly({ artifacts: [artifact(1, 10)], keepRunIds: [''] })).toThrow(/--keep-run/)
  })
})

describe('directoryBytes', () => {
  let tmp: string
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'velloc-prune-test-'))
  })
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('sums the files of a nested tree', () => {
    mkdirSync(join(tmp, 'a', 'b'), { recursive: true })
    writeFileSync(join(tmp, 'runtime.zip'), Buffer.alloc(1000))
    writeFileSync(join(tmp, 'a', 'b', 'manifest.json'), Buffer.alloc(234))
    expect(directoryBytes(tmp)).toBe(1234)
  })
})

describe('Workflow A prunes storage before the upload', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const doc = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'build-beta.yml'), 'utf8'))
  const pack = doc.jobs.pack as {
    permissions: Record<string, string>
    steps: Array<{ id?: string, name?: string, uses?: string, run?: string, env?: Record<string, string> }>
  }

  it('runs the prune step after packing and right before the candidate upload', () => {
    const prune = pack.steps.findIndex(s => /node scripts\/prune_artifacts\.mjs/.test(s.run ?? ''))
    const upload = pack.steps.findIndex(s => s.uses?.startsWith('actions/upload-artifact@'))
    const packStep = pack.steps.findIndex(s => /node scripts\/pack_artifact\.mjs/.test(s.run ?? ''))
    expect(prune).toBeGreaterThan(packStep)
    expect(upload).toBe(prune + 1)
    expect(pack.steps[prune].run).toContain('--incoming artifact/')
  })

  it('keeps the candidate beta serves and can delete the rest', () => {
    const prune = pack.steps.find(s => /prune_artifacts/.test(s.run ?? ''))!
    expect(prune.env?.BETA_RUN).toBe('${{ steps.beta_baseline.outputs.run_id }}')
    expect(prune.run).toContain('--keep-run "$BETA_RUN"')
    const baseline = pack.steps.find(s => s.id === 'beta_baseline')!
    expect(baseline.run).toContain('echo "run_id=$BRUN" >> "$GITHUB_OUTPUT"')
    expect(pack.permissions).toEqual({ contents: 'read', actions: 'write' })
  })

  it('defaults the quota to the Free plan when the repository variable is unset', () => {
    const prune = pack.steps.find(s => /prune_artifacts/.test(s.run ?? ''))!
    expect(prune.env?.QUOTA).toBe("${{ vars.ARTIFACT_QUOTA_BYTES || '500000000' }}")
  })
})

describe('Workflow A retires superseded candidates after the beta deploy', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const doc = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'build-beta.yml'), 'utf8'))
  const retire = doc.jobs.retire as {
    needs: string[]
    permissions: Record<string, string>
    steps: Array<{ uses?: string, run?: string, with?: Record<string, string>, 'continue-on-error'?: boolean }>
  }

  it('runs only after deploy, on the commit `source` resolved', () => {
    expect([retire.needs].flat().sort()).toEqual(['deploy', 'source'])
    const checkout = retire.steps.find(s => s.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.ref).toBe('${{ needs.source.outputs.commit }}')
    expect(retire.permissions).toEqual({ contents: 'read', actions: 'write' })
  })

  it('keeps only this run\'s candidate, and a failure there cannot fail the run', () => {
    const step = retire.steps.find(s => /prune_artifacts/.test(s.run ?? ''))!
    expect(step.run).toBe('node scripts/prune_artifacts.mjs --keep-only --keep-run "$GITHUB_RUN_ID"')
    expect(step['continue-on-error']).toBe(true)
  })
})
