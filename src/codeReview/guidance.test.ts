import { describe, expect, it } from 'vitest'
import { reviewEffortDirective } from './guidance'

describe('explicit review effort directive', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('recognizes an explicit %s directive', level => {
    expect(reviewEffortDirective(`Project rules\nReview effort: ${level}\nOther guidance`)).toBe(level)
  })
  it.each(['Use max for everything', '> Review effort: max', '- Review effort: max', 'Review effort: maximum', '```text\nReview effort: max\n```', '~~~\nReview effort: max\n~~~'])('ignores prose, quotations, and examples', content => {
    expect(reviewEffortDirective(content)).toBeUndefined()
  })
  it('uses the last explicit directive outside code fences', () => {
    expect(reviewEffortDirective('Review effort: high\n```\nReview effort: max\n```\nReview effort: medium')).toBe('medium')
  })
})
