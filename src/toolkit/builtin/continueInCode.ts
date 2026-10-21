// ContinueInCode: a chat session's offer to move the conversation into a Code
// session. The call itself changes nothing; the transcript renders it as a
// card where the user picks a folder and the shell forks the chat into a
// `code` session there. (F-17)

import type { ToolContract, InputCheck } from '../toolContract'
import { declareTool } from '../toolContract'

export const CONTINUE_IN_CODE_TOOL_ID = 'ContinueInCode'

export type ContinueInCodeInput = {
  reason: string
}

export const ContinueInCodeTool: ToolContract<ContinueInCodeInput, string> = declareTool({
  name: CONTINUE_IN_CODE_TOOL_ID,
  discoveryHint: 'offer to continue this conversation in a Code session with local file and shell access',
  argsSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description:
          'One short sentence, in the language the user writes in, saying what the request needs that this chat cannot do (for example: edit files in their project, run the tests).',
      },
    },
    required: ['reason'],
  },
  description: async () =>
    'Offer to continue this conversation in a Code session, which can read and edit files in a project folder and run commands. Use it when the user asks for something that needs their local files, a project folder or a shell. The user sees a card to pick a folder; their request reopens there. After calling it, end your turn with one short line; do not attempt the local work here.',
  parallelSafe: () => true,
  readsOnly: () => true,
  async checkInput(input: ContinueInCodeInput): Promise<InputCheck> {
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
      return { result: false, message: 'reason is required.', errorCode: 1 }
    }
    return { result: true }
  },
  async call() {
    return {
      data: 'The user now sees an offer to continue in a Code session and will choose a folder there. End your turn with one short line.',
    }
  },
})
