import { describe, expect, it } from 'vitest'
import {
  describeInTense,
  inflectDescription,
  tenseForCallStatus,
} from '../utils/descriptionTense'

describe('inflectDescription', () => {
  it('turns the opening verb into the past tense', () => {
    expect(inflectDescription('Find doc passages to update', 'past')).toBe(
      'Found doc passages to update',
    )
    expect(inflectDescription('Update the feature doc', 'past')).toBe(
      'Updated the feature doc',
    )
    expect(inflectDescription('Move the edit into a worktree', 'past')).toBe(
      'Moved the edit into a worktree',
    )
    expect(inflectDescription('Read doc sections', 'past')).toBe(
      'Read doc sections',
    )
  })

  it('turns the opening verb into the progressive', () => {
    expect(inflectDescription('Find doc passages to update', 'progressive')).toBe(
      'Finding doc passages to update',
    )
    expect(inflectDescription('Run the test suite', 'progressive')).toBe(
      'Running the test suite',
    )
    expect(inflectDescription('Write the handoff', 'progressive')).toBe(
      'Writing the handoff',
    )
  })

  it('applies the suffix rules to regular verbs', () => {
    const cases: Array<[string, string, string]> = [
      ['Commit the change', 'Committed the change', 'Committing the change'],
      ['Copy the file', 'Copied the file', 'Copying the file'],
      ['Deploy the build', 'Deployed the build', 'Deploying the build'],
      ['Remove the folder', 'Removed the folder', 'Removing the folder'],
      ['Queue the job', 'Queued the job', 'Queuing the job'],
      ['Format the sources', 'Formatted the sources', 'Formatting the sources'],
      ['Fix the import', 'Fixed the import', 'Fixing the import'],
      ['Retry the upload', 'Retried the upload', 'Retrying the upload'],
      ['Grep for the key', 'Grepped for the key', 'Grepping for the key'],
      ['Typecheck the tree', 'Typechecked the tree', 'Typechecking the tree'],
    ]
    for (const [base, past, progressive] of cases) {
      expect(inflectDescription(base, 'past')).toBe(past)
      expect(inflectDescription(base, 'progressive')).toBe(progressive)
    }
  })

  it('follows the verb into a later clause', () => {
    expect(
      inflectDescription('Commit both repos and run guards', 'past'),
    ).toBe('Committed both repos and ran guards')
    expect(
      inflectDescription('Commit both repos and run guards', 'progressive'),
    ).toBe('Committing both repos and running guards')
    expect(
      inflectDescription('Rerun the tests; find the i18n mention', 'past'),
    ).toBe('Reran the tests; found the i18n mention')
    expect(
      inflectDescription('Build the app, then start the server', 'past'),
    ).toBe('Built the app, then started the server')
  })

  it('converts "and <verb>" through to the end of the text', () => {
    expect(inflectDescription('Commit and push', 'past')).toBe('Committed and pushed')
    expect(inflectDescription('Stage, commit and push', 'progressive')).toBe(
      'Staging, committing and pushing',
    )
  })

  it('keeps the whole text as written when "and" may be followed by a noun', () => {
    for (const text of [
      'Show status and diff',
      'Find source and test files',
      'Read the config and log output',
    ]) {
      expect(inflectDescription(text, 'past')).toBe(text)
      expect(inflectDescription(text, 'progressive')).toBe(text)
    }
    expect(inflectDescription('Show status, diff and the log', 'past')).toBe(
      'Show status, diff and the log',
    )
    expect(inflectDescription('Show the status, then the log', 'past')).toBe(
      'Showed the status, then the log',
    )
  })

  it('keeps the case of the word and any leading space', () => {
    expect(inflectDescription('run the tests', 'past')).toBe('ran the tests')
    expect(inflectDescription('  Run the tests', 'past')).toBe('  Ran the tests')
  })

  it('returns text that does not open with a known verb unchanged', () => {
    for (const text of [
      'Full vitest run',
      'Tests and guards',
      '运行测试套件',
      'Running the tests',
      '',
      '   ',
      '42 files to check',
      'constructor lookup',
    ]) {
      expect(inflectDescription(text, 'past')).toBe(text)
      expect(inflectDescription(text, 'progressive')).toBe(text)
    }
  })

  it('picks the tense from the call status', () => {
    expect(tenseForCallStatus('running', undefined)).toBe('progressive')
    expect(tenseForCallStatus('complete', false)).toBe('past')
    expect(tenseForCallStatus('complete', undefined)).toBe('past')
    expect(tenseForCallStatus('complete', true)).toBeUndefined()
    expect(tenseForCallStatus('incomplete', undefined)).toBeUndefined()
    expect(tenseForCallStatus(undefined, undefined)).toBeUndefined()
  })

  it('leaves the text as written when no tense is given', () => {
    expect(describeInTense('Run the tests', undefined)).toBe('Run the tests')
    expect(describeInTense('Run the tests', 'past')).toBe('Ran the tests')
  })
})
