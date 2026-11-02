import { describe, expect, it, vi } from 'vitest'
import type { ActionReceipt, Diagnostic } from './contracts'
import { bindChangeRequestTarget, type ChangeRequestSnapshot } from './platform-adapter'
import { prepareReviewPublicationBody, proposeReviewSuggestion } from './publication-content'
import type { ReviewModelRunner } from './runner'
import { parseUnifiedDiff } from './scope'

const base = 'a'.repeat(40), head = 'b'.repeat(40)
async function harness(count = 1) {
  const old = Array.from({ length: count }, () => '-return input.value;').join('\n')
  const added = Array.from({ length: count }, () => '+return input.value.trim();').join('\n')
  const files = await parseUnifiedDiff(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,${count} +1,${count} @@\n${old}\n${added}\n`, { base, head })
  const anchor = files[0].anchors.find(item => item.side === 'after')!
  const snapshot: ChangeRequestSnapshot = {
    target: bindChangeRequestTarget(['https://github.com/owner/repo'], 12), base, head,
    manifest: { scope: { kind: 'change-request', workspaceKey: 'w', repository: { platform: 'github', projectKey: 'owner/repo' }, revision: { base, head }, pathFilter: [] }, files, anchors: files.flatMap(file => file.anchors), complete: true, status: 'reviewable', notices: [], baseSource: 'change-request', semantics: 'three-dot' },
  }
  const diagnostic: Diagnostic = { id: 'd1', runId: 'r1', anchor, claim: { title: 'Null value crashes', explanation: 'Optional values can be null.', trigger: 'Missing value' }, classification: { kind: 'correctness', impact: 'major' }, evidenceKeys: [], origin: { angle: 'calls' } }
  const original = Array.from({ length: count }, () => 'return input.value.trim();').join('\n')
  const proposal = { diagnosticId: 'd1', rootCauseFingerprint: 'null-value', original, replacement: 'return (input.value ?? "").trim();', rationale: 'Handles the absent value before trimming.', complete: true }
  const verified = { ...proposal, sameMechanism: true, completeFix: true, partial: false, rationale: 'The missing-value trigger now uses an empty string; present strings retain trimming.' }
  const runner = vi.fn<ReviewModelRunner>().mockResolvedValueOnce({ interrupted: false, text: JSON.stringify(proposal) }).mockResolvedValueOnce({ interrupted: false, text: JSON.stringify(verified) })
  const reader = { checkHead: vi.fn(async () => {}), readContext: vi.fn(async () => original + '\n') }
  const controller = new AbortController()
  const input = { runner, reader, snapshot, diagnostic, rootCauseFingerprint: 'null-value', actions: [] as ActionReceipt[], taskId: 'task', signal: controller.signal }
  return { input, runner, reader, proposal, verified, controller }
}
describe('optional complete-fix suggestions', () => {
  it('binds a twice-assessed proposal to host-read remote text without tools or test claims', async () => {
    const h = await harness()
    expect(await proposeReviewSuggestion(h.input)).toEqual({ diagnosticId: 'd1', rootCauseFingerprint: 'null-value', anchorKey: h.input.snapshot.manifest.anchors.find(anchor => anchor.side === 'after')!.anchorKey, path: 'a.ts', head, start: 1, end: 1, original: h.proposal.original, replacement: h.proposal.replacement, rationale: h.proposal.rationale, verificationRationale: h.verified.rationale })
    expect(h.reader.readContext).toHaveBeenCalledTimes(2)
    expect(h.reader.checkHead).toHaveBeenCalledTimes(2)
    expect(h.runner).toHaveBeenCalledTimes(2)
    const requests = h.runner.mock.calls.map(call => call[0])
    expect(requests.map(request => request.taskId)).toEqual(['task:propose', 'task:verify'])
    for (const request of requests) {
      expect(request).toMatchObject({ tools: [], execution: 'isolated', maxTurns: 2 })
      expect(request.blocks.find(block => block.source === 'pinned-remote-source')?.text).toContain(h.proposal.original)
    }
    expect(requests[1].blocks.find(block => block.source === 'untrusted-proposal')?.provenance).toBe('repository-material')
  })
  it.each([
    { completeFix: false }, { partial: true }, { sameMechanism: false }, { diagnosticId: 'd2' },
    { rootCauseFingerprint: 'other' }, { original: 'wrong' }, { replacement: 'different' }, { rationale: '' },
  ])('declines a partial, unclear or different verifier verdict %j', async verdict => {
    const h = await harness()
    h.runner.mockReset().mockResolvedValueOnce({ interrupted: false, text: JSON.stringify(h.proposal) }).mockResolvedValueOnce({ interrupted: false, text: JSON.stringify({ ...h.verified, ...verdict }) })
    expect(await proposeReviewSuggestion(h.input)).toBeUndefined()
  })
  it.each([
    { complete: false }, { original: 'invented' }, { diagnosticId: 'd2' }, { rootCauseFingerprint: 'other' },
    { replacement: '```\nescape' }, { replacement: '`template`' }, { replacement: '~~~' },
    { replacement: 'a\n'.repeat(10) }, { replacement: 'x'.repeat(4097) }, { replacement: 'a\u0000' },
    { replacement: 'return input.value.trim();' }, { rationale: '' },
  ])('declines invalid candidate before independent review %j', async change => {
    const h = await harness()
    h.runner.mockReset().mockResolvedValue({ interrupted: false, text: JSON.stringify({ ...h.proposal, ...change }) })
    expect(await proposeReviewSuggestion(h.input)).toBeUndefined()
    expect(h.runner).toHaveBeenCalledTimes(1)
  })
  it.each(['before', 'working-copy'] as const)('declines %s-side findings before model access', async side => {
    const h = await harness(); h.input.diagnostic.anchor.side = side
    expect(await proposeReviewSuggestion(h.input)).toBeUndefined(); expect(h.runner).not.toHaveBeenCalled()
  })
  it.each(['applied', 'unnecessary', 'running', 'requested'] as const)('declines host repair state %s', async state => {
    const h = await harness(); h.input.actions.push({ id: 'repair', kind: 'repair', state, diagnosticIds: ['d1'] })
    expect(await proposeReviewSuggestion(h.input)).toBeUndefined(); expect(h.runner).not.toHaveBeenCalled()
  })
  it('declines oversized anchors and supports the ten-line boundary', async () => {
    const tooLarge = await harness(11)
    expect(await proposeReviewSuggestion(tooLarge.input)).toBeUndefined(); expect(tooLarge.runner).not.toHaveBeenCalled()
    const allowed = await harness(10)
    expect(await proposeReviewSuggestion(allowed.input)).toMatchObject({ start: 1, end: 10 })
  })
  it('declines unsupported platforms, incomplete scope and unpinned locations', async () => {
    for (const change of [
      (h: Awaited<ReturnType<typeof harness>>) => { h.input.snapshot.target = { ...h.input.snapshot.target, platform: 'gitlab' } },
      (h: Awaited<ReturnType<typeof harness>>) => { h.input.snapshot.manifest.complete = false },
      (h: Awaited<ReturnType<typeof harness>>) => { h.input.diagnostic.anchor.revision = base },
      (h: Awaited<ReturnType<typeof harness>>) => { h.input.diagnostic.anchor.contextDigest = 'wrong' },
    ]) {
      const h = await harness(); h.input.diagnostic = structuredClone(h.input.diagnostic); change(h)
      expect(await proposeReviewSuggestion(h.input)).toBeUndefined(); expect(h.runner).not.toHaveBeenCalled()
    }
  })
  it.each(['binary', 'large', 'mismatch', 'stale'])('declines %s remote content', async kind => {
    const h = await harness()
    if (kind === 'binary') h.reader.readContext.mockResolvedValue('abc\u0000')
    if (kind === 'large') h.reader.readContext.mockResolvedValue('x'.repeat(64 * 1024 + 1))
    if (kind === 'mismatch') h.reader.readContext.mockResolvedValueOnce(h.proposal.original).mockResolvedValue('changed')
    if (kind === 'stale') h.reader.checkHead.mockRejectedValue(new Error('head-changed'))
    expect(await proposeReviewSuggestion(h.input)).toBeUndefined()
  })
  it.each(['null', '{}', 'not JSON', '```json\n{}\n```'])('declines unsupported model output %s', async text => {
    const h = await harness(); h.runner.mockReset().mockResolvedValue({ interrupted: false, text })
    expect(await proposeReviewSuggestion(h.input)).toBeUndefined(); expect(h.runner).toHaveBeenCalledTimes(1)
  })
  it('declines a runner error without exposing it as publication text', async () => {
    const h = await harness(); h.runner.mockReset().mockRejectedValue(new Error('private provider details'))
    expect(await proposeReviewSuggestion(h.input)).toBeUndefined()
  })
  it.each([0, 1])('declines interrupted model phase %i', async phase => {
    const h = await harness(); h.runner.mockReset()
    if (phase) h.runner.mockResolvedValueOnce({ interrupted: false, text: JSON.stringify(h.proposal) })
    h.runner.mockResolvedValueOnce({ interrupted: true, text: JSON.stringify(phase ? h.verified : h.proposal) })
    expect(await proposeReviewSuggestion(h.input)).toBeUndefined()
  })
  it('bounds a runner ignoring cancellation and never starts another phase', async () => {
    const h = await harness(); h.runner.mockReset().mockImplementation(async () => new Promise(() => {}))
    expect(await proposeReviewSuggestion({ ...h.input, timeoutMs: 5 })).toBeUndefined()
    expect(h.runner).toHaveBeenCalledTimes(1); expect(h.runner.mock.calls[0][0].signal.aborted).toBe(true)
  })
  it('declines pre-cancelled and mid-run cancelled requests', async () => {
    const h = await harness(); h.controller.abort()
    expect(await proposeReviewSuggestion(h.input)).toBeUndefined(); expect(h.runner).not.toHaveBeenCalled()
    const active = await harness()
    active.runner.mockReset().mockImplementation(async () => { active.controller.abort(); return { interrupted: false, text: JSON.stringify(active.proposal) } })
    expect(await proposeReviewSuggestion(active.input)).toBeUndefined(); expect(active.runner).toHaveBeenCalledTimes(1)
  })
})
it('formats public findings and host action status without grants, raw receipts or invented verification', async () => {
  const h = await harness()
  const action = { id: 'private-receipt', kind: 'repair' as const, state: 'applied' as const, diagnosticIds: ['d1', 'private-id'], reason: 'private authorization', executionRef: 'secret', verification: 'not-run' as const, grant: { token: 'secret' } }
  const labels = { finding: vi.fn(finding => `${finding.claim.title}\n${finding.claim.explanation}`), action: vi.fn(status => `${status.kind}: ${status.state} (${status.verification})`) }
  const text = prepareReviewPublicationBody({ diagnostics: [h.input.diagnostic], actions: [action], labels, body: 'Review findings' })
  expect(text).toBe('Review findings\n\nNull value crashes\nOptional values can be null.\n\nrepair: applied (not-run)')
  expect(labels.action).toHaveBeenCalledWith({ kind: 'repair', state: 'applied', diagnosticIds: ['d1'], verification: 'not-run' })
  expect(JSON.stringify(labels.finding.mock.calls)).not.toMatch(/runId|contextDigest|evidenceKeys|taskKey/)
  expect(text).not.toMatch(/secret|grant|private|passed/)
})
