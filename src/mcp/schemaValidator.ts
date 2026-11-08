import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation/types.js'

/**
 * Contract: the `jsonSchemaValidator` of every SDK `Client` Velloc creates.
 * Velloc reads a tool result as content and never rejects it on
 * output-schema grounds. A declared `outputSchema` that fails to compile
 * yields a validator that accepts every value, so the tool stays listed; a
 * result that disagrees with a schema that did compile is reported once per
 * schema through `console.warn('[mcp] …')` and then passed through as valid.
 * Without this one unparseable schema costs a server its whole tool list,
 * and a correct call fails on the server's own declaration.
 *
 * Ajv is set up as the SDK's default validator is, except patterns compile
 * without the `u` flag: servers publish patterns such as `^https\://` that
 * only the unicode mode rejects.
 */
export function createTolerantSchemaValidator(
  warn: (message: string) => void = message => console.warn(message),
): jsonSchemaValidator {
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
          `[mcp] A tool's output schema does not compile; its results are accepted unchecked: ${describe(err)}`,
        )
        return input => ({ valid: true, data: input as T, errorMessage: undefined })
      }
      let reported = false
      return input => {
        let mismatch: string | undefined
        try {
          if (!compiled(input)) mismatch = ajv.errorsText(compiled.errors)
        } catch (err) {
          mismatch = describe(err)
        }
        if (mismatch !== undefined && !reported) {
          reported = true
          warn(
            `[mcp] A tool result does not match the tool's declared output schema; passing it through: ${mismatch}`,
          )
        }
        return { valid: true, data: input as T, errorMessage: undefined }
      }
    },
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
