import type { RuntimeFs } from '../../utils/fs/runtimeFs'

/**
 * How much of a task's output file the Background Tasks detail view reads: the
 * last 256 KiB. Larger than the live tail (`SHELL_OUTPUT_TAIL_BYTES`) so a
 * finished run shows more history, and small enough that the window's ANSI
 * strip and one wrapped `<pre>` stay well inside a frame (F-2).
 */
export const TASK_OUTPUT_VIEW_BYTES = 256 * 1024

/** The tail of an output file, its full size in bytes, and whether it was cut. */
export type TaskOutputTail = { text: string; size: number; truncated: boolean }

const LEADING_REPLACEMENT = /^�{1,3}/

/**
 * Contract: reads at most `maxBytes` from the end of `path`, decoded as UTF-8.
 * A cut that splits a multi-byte character drops the broken lead. Uses the
 * fs's ranged read; an fs without one reads the whole file and keeps the tail,
 * so the caller's result is bounded either way. Rejects when the file cannot
 * be read.
 */
export async function readTaskOutputTail(
  fs: RuntimeFs,
  path: string,
  maxBytes: number = TASK_OUTPUT_VIEW_BYTES,
): Promise<TaskOutputTail> {
  if (!fs.readRange) {
    const whole = new TextEncoder().encode(await fs.readFile(path, { encoding: 'utf-8' }))
    const offset = Math.max(0, whole.length - maxBytes)
    return decodeTail(whole.subarray(offset), whole.length, offset > 0)
  }
  const { size } = await fs.stat(path)
  if (size <= 0) return { text: '', size: 0, truncated: false }
  const offset = Math.max(0, size - maxBytes)
  const { buffer, bytesRead } = await fs.readRange(path, { offset, length: size - offset })
  return decodeTail(buffer.subarray(0, bytesRead), size, offset > 0)
}

function decodeTail(bytes: Uint8Array, size: number, truncated: boolean): TaskOutputTail {
  const text = new TextDecoder('utf-8').decode(bytes)
  return { text: truncated ? text.replace(LEADING_REPLACEMENT, '') : text, size, truncated }
}
