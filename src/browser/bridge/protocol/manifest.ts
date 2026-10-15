export type HostedToolDefinition = {
  type: 'function'
  name: string
  description: string
  parameters: {
    [key: string]: unknown
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
  /**
   * Optional strict-mode JSON Schema variant, used when the model's catalog entry
   * has `supportsStrictTools: true`; tools without one skip strict mode.
   */
  parametersStrict?: HostedToolDefinition['parameters']
  /**
   * Optional example calls (`input` dicts). Each MUST validate against `parameters`
   * (Anthropic returns 400 otherwise); the C++ side decides what to surface per provider.
   */
  inputExamples?: Array<Record<string, unknown>>
  aliases?: string[]
  searchHint?: string
  readOnly?: boolean
  concurrencySafe?: boolean
  // Skill bucket this tool belongs to (from the C++ *.tool.json `skill`
  // field), or absent for an always-loaded tool. When the owning skill
  // is `deferred` and not yet activated, the serializer omits this
  // tool's schema from tools[]. See giggly-watching-pie.md Phase 4 and
  // toolkit/run/deferredTools.ts.
  skill?: string
}

// A hosted skill (the runtime's own definitions, e.g. the browser skill).
// A skill is a named bucket of tools (membership = tools whose `skill`
// matches `name`) that activate together via the Skill tool. On
// activation the `instructions` are injected and the bucket's tools
// become callable.
export type HostedSkillDefinition = {
  name: string
  description: string
  instructions: string
  // Names of the tools in this skill, derived C++-side from each tool's
  // `skill` field (single source of truth, no drift). Whether the skill DEFERS
  // is decided SOLELY by the session template's `deferredTools` — there is no
  // per-skill `default` deferral marker anymore (template is the only control).
  toolNames: string[]
}

export type BrowserHostManifest = {
  hostKind?: string
  capabilities: string[]
  toolNames: string[]
  commandNames: string[]
  hostedTools: HostedToolDefinition[]
  // The skills the host's tool set brings with it (resolved at boot from
  // the runtime's host tool definitions).
  hostedSkills?: HostedSkillDefinition[]
  compactableToolNames?: string[]
  // Boot snapshot of the unified agent runtime config (maxTurns,
  // model, …). Applied once after the runtime is built;
  // later changes arrive live via the `session.applyAgentConfig` event.
  // Kept loosely typed — the worker applies only the keys it recognizes.
  agentConfig?: Record<string, unknown>
  // The LLM bridge accepts a `document` part at the TOP level of a message
  // (an @-mentioned PDF inlined by the guest), not only inside a tool result.
  // Absent on older binaries, which reject such a part and fail the turn —
  // callers must fall back (nexus_host_manifest.cc).
  llmDocumentParts?: boolean
  // The additive native primitives this host serves, by `<capability>.<action>`
  // or a named variant (`fs.writeFile.ifMatch`, `shell.spawn.persist`) —
  // nexus_host_manifest.cc `kNativePrimitives`. Absent on older binaries.
  // `bridge/nativePrimitives.ts` checks it before calling, which is what lets
  // a variant an older host would silently IGNORE ship without a bump.
  primitives?: string[]
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const sanitized: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue
    }
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    sanitized.push(trimmed)
  }
  return sanitized
}

export function normalizeHostedToolDefinitions(value: unknown): HostedToolDefinition[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const definitions: HostedToolDefinition[] = []

  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue
    }

    const record = entry as Record<string, unknown>
    const name =
      typeof record.name === 'string' ? record.name.trim() : ''
    const description =
      typeof record.description === 'string' ? record.description.trim() : ''
    const parameters =
      record.parameters && typeof record.parameters === 'object' &&
          !Array.isArray(record.parameters)
        ? (record.parameters as HostedToolDefinition['parameters'])
        : undefined
    const parametersStrict =
      record.parametersStrict &&
      typeof record.parametersStrict === 'object' &&
      !Array.isArray(record.parametersStrict) &&
      (record.parametersStrict as { type?: unknown }).type === 'object'
        ? (record.parametersStrict as HostedToolDefinition['parameters'])
        : undefined
    // `inputExamples` arrives as an array; we sanitize to "list of
    // plain object dicts" without inspecting individual fields. Per-
    // schema validation is the C++ tool author's job (and Anthropic
    // does its own check on the wire — 400 on violation).
    const inputExamples = Array.isArray(record.inputExamples)
      ? record.inputExamples.filter(
          (entry): entry is Record<string, unknown> =>
            !!entry && typeof entry === 'object' && !Array.isArray(entry),
        )
      : undefined

    if (
      record.type !== 'function' ||
      !name ||
      !description ||
      !parameters ||
      parameters.type !== 'object' ||
      seen.has(name)
    ) {
      continue
    }

    seen.add(name)
    definitions.push({
      type: 'function',
      name,
      description,
      parameters,
      ...(parametersStrict ? { parametersStrict } : {}),
      ...(inputExamples && inputExamples.length > 0
        ? { inputExamples }
        : {}),
      aliases: sanitizeStringArray(record.aliases),
      searchHint:
        typeof record.searchHint === 'string' && record.searchHint.trim()
          ? record.searchHint.trim()
          : undefined,
      readOnly: record.readOnly === true,
      concurrencySafe: record.concurrencySafe === true,
      ...(typeof record.skill === 'string' && record.skill.trim()
        ? { skill: record.skill.trim() }
        : {}),
    })
  }

  return definitions
}

export function normalizeHostedSkillDefinitions(
  value: unknown,
): HostedSkillDefinition[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const skills: HostedSkillDefinition[] = []

  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue
    }
    const record = entry as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const description =
      typeof record.description === 'string' ? record.description.trim() : ''
    if (!name || seen.has(name)) {
      continue
    }
    seen.add(name)
    skills.push({
      name,
      description,
      instructions:
        typeof record.instructions === 'string' ? record.instructions : '',
      // No `default` deferral marker — deferral is decided SOLELY by the session
      // template's `deferredTools` (resolveDeferrableSkills). Any `default` field
      // the host still sends is ignored here.
      toolNames: sanitizeStringArray(record.toolNames),
    })
  }

  return skills
}

export function normalizeBrowserHostManifest(
  value: unknown,
): BrowserHostManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  const hostedTools = normalizeHostedToolDefinitions(record.hostedTools)
  const hostedSkills = normalizeHostedSkillDefinitions(record.hostedSkills)
  const toolNames = sanitizeStringArray(record.toolNames)
  const compactableToolNames = sanitizeStringArray(record.compactableToolNames)
  return {
    hostKind:
      typeof record.hostKind === 'string' && record.hostKind.trim()
        ? record.hostKind.trim()
        : undefined,
    capabilities: sanitizeStringArray(record.capabilities),
    toolNames:
      toolNames.length > 0 ? toolNames : hostedTools.map(tool => tool.name),
    commandNames: sanitizeStringArray(record.commandNames),
    hostedTools,
    hostedSkills: hostedSkills.length > 0 ? hostedSkills : undefined,
    compactableToolNames:
      compactableToolNames.length > 0 ? compactableToolNames : undefined,
    agentConfig:
      record.agentConfig && typeof record.agentConfig === 'object' &&
          !Array.isArray(record.agentConfig)
        ? (record.agentConfig as Record<string, unknown>)
        : undefined,
    llmDocumentParts: record.llmDocumentParts === true ? true : undefined,
    primitives: Array.isArray(record.primitives)
      ? sanitizeStringArray(record.primitives)
      : undefined,
  }
}
