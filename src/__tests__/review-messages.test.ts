import { describe, expect, it } from 'vitest'
import { createTranslate } from '../browser/webview/i18n/translate'
import { reviewMessage, reviewDetailMessage, reviewAngleMessage, reviewValueMessage, reviewEndMessage, reviewTaskRoleMessage } from '../codeReview/messages'
import type { PolicyNotice } from '../codeReview/contracts'
import { parseReviewArguments } from '../codeReview/arguments'
const t = createTranslate('en')
const policy: PolicyNotice[] = [
  { code: 'level-reused', level: 'high' }, { code: 'max-not-authorized', level: 'medium' },
  { code: 'panel-limit', requested: 'unlimited', effective: 32 }, { code: 'careful-pass-limit', requested: 99, effective: 32 },
  { code: 'quantity-ignored', requested: 12 }, { code: 'agent-unavailable' }, { code: 'agent-denied' }, { code: 'agent-depth-exhausted' },
  { code: 'tests-fixtures-skipped' }, { code: 'tests-fixtures-reviewed' }, { code: 'output-tool-unavailable' }, { code: 'coordinator-worker-required' }, { code: 'coordinator-worker-unavailable' },
  { code: 'reasoning-mapped', requested: 'xhigh', effective: 'high' }, { code: 'committed-lines-only' },
]
describe('review localization', () => {
  it.each(['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de'] as const)('localizes every policy variant in %s', locale => {
    const translate = createTranslate(locale)
    for (const notice of policy) {
      const result = reviewMessage(translate, notice)
      expect(result).not.toBe(translate('reviewCard.notice.unknown'))
      expect(result).not.toContain(notice.code)
      expect(result).not.toMatch(/reviewCard\.|\{(?:level|requested|effective)\}/)
    }
  })
  it.each(['ultra', '--unknown', '--max-findings', '--max-findings 0', 'one two', '""', '"unfinished'])('adds supported syntax to parser failure %s', input => {
    const parsed = parseReviewArguments(input)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    const message = reviewMessage(t, parsed.error)
    expect(message).toContain('/code-review [low|medium|high|xhigh|max]')
    expect(message).toContain('--max-findings n|all|default')
    expect(message).not.toContain(parsed.error.code)
  })
  it.each(['other-untracked-files-excluded', 'initial-commit-all-tracked-files', 'diff-output-limit', 'remote-diff-incomplete', 'remote-patch-unavailable', 'publication-target-required', 'publication-target-unavailable', 'review-read-not-authorized', 'ambiguous-target', 'ambiguous-review-target', 'scope-incomplete', 'independent-worker-coverage-incomplete', 'review-budget-exhausted', 'head-changed', 'publication-failed', 'write-outcome-unknown', 'repair-workspace-mismatch', 'invalid-review-read'])('maps scope and service reason %s', code => {
    expect(reviewMessage(t, code)).not.toBe(t('reviewCard.notice.unknown'))
    expect(reviewDetailMessage(t, code)).toBe(reviewMessage(t, code))
  })
  it('reads a stored legacy interruption code and a time-limit end as the interrupted notice', () => {
    expect(reviewDetailMessage(t, 'review-budget-or-model-interrupted')).toBe(t('reviewCard.notice.interrupted'))
    expect(reviewEndMessage(t, { kind: 'time-limit' })).toBe(t('reviewCard.notice.interrupted'))
  })
  it('retains prose, suppresses unknown codes, and never interpolates invalid structured values', () => {
    expect(reviewDetailMessage(t, 'The generated fixture could not be checked.')).toBe('The generated fixture could not be checked.')
    expect(reviewDetailMessage(t, 'future-error-code')).toBe(t('reviewCard.notice.unknown'))
    expect(reviewMessage(t, { code: 'unknown-new-code', path: '/secret', params: { secret: 'TOKEN' } })).not.toMatch(/secret|TOKEN|unknown-new-code/)
    expect(reviewMessage(t, { code: 'reasoning-mapped', requested: 'TOKEN', effective: {} })).not.toContain('TOKEN')
    expect(reviewMessage(t, { code: 'panel-limit', params: { requested: 'all', effective: 32 } })).toBe(t('reviewCard.notice.cap', { requested: t('reviewCard.value.unlimited'), effective: 32 }))
  })
  it('translates angle and stage identifiers and falls back safely for newer values', () => {
    expect(reviewAngleMessage(t, 'removed')).toBe(t('reviewCard.angle.removed'))
    expect(reviewValueMessage(t, 'scope')).toBe(t('reviewCard.value.scope'))
    expect(reviewValueMessage(t, 'future-stage')).toBe(t('reviewCard.notice.unspecified'))
    expect(reviewAngleMessage(t, 'future-angle')).toBe(t('reviewCard.notice.unspecified'))
  })
  it.each(['en', 'zh', 'ja', 'ko', 'es', 'fr', 'de'] as const)('names the mechanism and publication task roles in %s', locale => {
    const translate = createTranslate(locale)
    for (const role of ['mechanism', 'publication']) {
      expect(reviewTaskRoleMessage(translate, role)).toBe(translate(`reviewCard.task.role.${role}` as Parameters<typeof translate>[0]))
      expect(reviewTaskRoleMessage(translate, role)).not.toMatch(/reviewCard\.|unspecified/)
    }
  })
})
