/**
 * YAML parsing wrapper.
 *
 * Nexus Web is a browser bundle — there is no `require` — so the `yaml`
 * package is imported directly. A static import keeps `parseYaml`
 * synchronous; the parser is needed at startup to read every skill's
 * frontmatter, so there is nothing to defer with a lazy import.
 */
import { parse } from 'yaml'

export function parseYaml(input: string): unknown {
  return parse(input)
}
