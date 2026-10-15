import type {
  ProcessUserInputParams,
  ProcessUserInputResult,
  UserInputPipeline,
} from '../../../runtime/interfaces/UserInputPipeline'
import type { Message } from '../../../runtime/RuntimeTypes'
import type { ReplayRuntimeConfig } from './runtime'
import { TraceRecorder, toJson } from './trace'

/**
 * The user input layer for the built-in command scenarios: a typed prompt
 * enters for the model; the five built-in commands answer with the action the
 * engine runs and a command output row, as the input layer does. Each call is
 * recorded (what the engine handed the input layer).
 */
export class SlashPipeline implements UserInputPipeline {
  constructor(
    private readonly runtimeConfig: ReplayRuntimeConfig,
    private readonly recorder: TraceRecorder,
  ) {}

  async processUserInput(params: ProcessUserInputParams): Promise<ProcessUserInputResult> {
    const input = params.input
    this.recorder.note({ processUserInput: toJson(input), isMeta: params.isMeta, origin: params.origin })
    const user = (content: unknown): Message =>
      ({
        type: 'user',
        uuid: params.uuid ?? this.runtimeConfig.createUUID(),
        timestamp: this.runtimeConfig.createTimestamp(),
        message: { role: 'user', content },
        isMeta: params.isMeta ?? false,
        ...(params.origin ? { origin: params.origin } : {}),
      }) as unknown as Message
    const output = (text: string): Message =>
      ({
        type: 'system',
        subtype: 'informational',
        uuid: this.runtimeConfig.createUUID(),
        timestamp: this.runtimeConfig.createTimestamp(),
        content: text,
        level: 'info',
      }) as unknown as Message
    if (typeof input === 'string' && input.trim().startsWith('/')) {
      const [command, ...rest] = input.trim().slice(1).split(/\s+/)
      const args = rest.join(' ')
      const echo = user(input)
      switch (command) {
        case 'clear':
          return { action: 'clear', messages: [echo, output('Conversation cleared.')], shouldQuery: false, resultText: '' }
        case 'compact':
          return {
            action: 'compact',
            ...(args ? { compactInstructions: args } : {}),
            messages: [echo],
            shouldQuery: false,
            resultText: '',
          }
        case 'plugins':
          return { action: 'reload-plugins', enabledPlugins: args ? args.split(',') : [], messages: [echo, output('Plugins reloaded.')], shouldQuery: false }
        case 'mcp':
          return { action: 'open-settings', settingsSection: 'mcp', messages: [echo, output('Opening MCP settings.')], shouldQuery: false }
        case 'rename':
          return { action: 'rename', renameTitle: args, messages: [echo, output(`Renamed to ${args}.`)], shouldQuery: false }
        default:
          return { messages: [echo, output(`Unknown command: /${command}`)], shouldQuery: false }
      }
    }
    return {
      messages: [user(input)],
      shouldQuery: true,
      resultText: typeof input === 'string' ? input : '[content-block-input]',
    }
  }
}
