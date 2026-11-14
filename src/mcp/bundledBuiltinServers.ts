/**
 * The built-in MCP servers every realm starts with (F-10). Registration is
 * explicit and idempotent: the runtime calls it before it reads a session's
 * offering.
 */
import { createSessionTurnServer } from '../sessions/sessionTurnServer'
import { registerBuiltinMcpServer } from './builtinServers'

let registered = false

export function registerBundledBuiltinMcpServers(): void {
  if (registered) return
  registered = true
  registerBuiltinMcpServer(createSessionTurnServer())
}
