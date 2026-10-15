/**
 * Zod schemas for permission updates.
 *
 * Validates RuleEdit objects at runtime boundaries (worker protocol,
 * settings persistence). Velloc uses `rules: string[]` (serialized rule strings
 * like "Bash(npm:*)"), not structured rule objects.
 */
import { z } from 'zod/v4'

export const ruleTargetSchema = z.enum([
  'userSettings',
  'projectSettings',
  'localSettings',
  'session',
  'cliArg',
])

export const permissionRuleBehaviorSchema = z.enum(['allow', 'deny', 'ask'])

export const ruleEditSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('addRules'),
    rules: z.array(z.string()),
    behavior: permissionRuleBehaviorSchema,
    destination: ruleTargetSchema,
  }),
  z.object({
    type: z.literal('replaceRules'),
    rules: z.array(z.string()),
    behavior: permissionRuleBehaviorSchema,
    destination: ruleTargetSchema,
  }),
  z.object({
    type: z.literal('removeRules'),
    rules: z.array(z.string()),
    behavior: permissionRuleBehaviorSchema,
    destination: ruleTargetSchema,
  }),
  z.object({
    type: z.literal('setMode'),
    mode: z.string(),
    destination: ruleTargetSchema.optional(),
  }),
  z.object({
    type: z.literal('addDirectories'),
    directories: z.array(z.string()),
    destination: ruleTargetSchema,
  }),
  z.object({
    type: z.literal('removeDirectories'),
    directories: z.array(z.string()),
    destination: ruleTargetSchema,
  }),
])

export type PermissionUpdateInput = z.input<typeof ruleEditSchema>
export type PermissionUpdateOutput = z.output<typeof ruleEditSchema>
