export function stripAnsiControlSequences(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|\x07)/g, '')
    .replace(/\x1b[@-_]/g, '')
}
