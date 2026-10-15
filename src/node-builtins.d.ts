declare module 'node:buffer' {
  export const Buffer: any
}

declare module 'node:crypto' {
  export function randomUUID(): string
}

declare module 'node:fs' {
  const fs: any
  export const promises: any
  export default fs
}

declare module 'node:path' {
  const path: any
  export default path
}

declare module 'node:process' {
  const process: {
    stdout: {
      write(value: string): void
    }
    exit(code?: number): never
  }
  export default process
}
