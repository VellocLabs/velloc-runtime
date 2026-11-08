import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation/types.js'

/**
 * Contract: the `jsonSchemaValidator` of every SDK `Client` Velloc creates
 * (`createMcpClient`). Velloc reads a tool result as content and never
 * rejects its `structuredContent` for disagreeing with the tool's declared
 * `outputSchema`. A schema that fails to compile yields a validator that
 * accepts every value, so the tool stays listed; a result that disagrees with
 * a schema that did compile is reported once per schema through
 * `console.warn('[mcp] Server "<name>": …')` and then passed through as
 * valid, and later results for that schema are not checked again. Nothing
 * downstream may treat `structuredContent` as schema-checked. The SDK still
 * rejects a non-error result that omits `structuredContent` for a tool that
 * declares an `outputSchema`; this validator is not consulted there.
 *
 * Ajv is set up as the SDK's default validator is, except patterns compile
 * without the `u` flag: servers publish patterns such as `^https\://` that
 * only the unicode mode rejects.
 */
export function createTolerantSchemaValidator(
  serverName: string,
  warn: (message: string) => void = message => console.warn(message),
): jsonSchemaValidator {
  const prefix = `[mcp] Server "${serverName}":`
  const ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
    unicodeRegExp: false,
  })
  addFormats(ajv)

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      let compiled: ReturnType<typeof ajv.compile>
      try {
        compiled = ajv.compile(schema)
      } catch (err) {
        warn(
          `${prefix} a tool's output schema does not compile; its results are accepted unchecked: ${describe(err)}`,
        )
        return input => ({ valid: true, data: input as T, errorMessage: undefined })
      }
      let reported = false
      return input => {
        if (!reported) {
          let mismatch: string | undefined
          try {
            if (!compiled(input)) mismatch = ajv.errorsText(compiled.errors)
          } catch (err) {
            mismatch = describe(err)
          }
          if (mismatch !== undefined) {
            reported = true
            warn(
              `${prefix} a tool result does not match the tool's declared output schema; passing it through: ${mismatch}`,
            )
          }
        }
        return { valid: true, data: input as T, errorMessage: undefined }
      }
    },
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
