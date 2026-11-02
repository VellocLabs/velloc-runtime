import { isReviewLevel } from './arguments'
import type { ReviewLevel } from './contracts'

export function reviewEffortDirective(content: string): ReviewLevel | undefined {
  let fence: string | undefined
  let level: ReviewLevel | undefined
  for (const line of content.split(/\r?\n/u)) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (fence) continue
    const value = /^Review effort: (low|medium|high|xhigh|max)\s*$/u.exec(line)?.[1]
    if (value && isReviewLevel(value)) level = value
  }
  return level
}
