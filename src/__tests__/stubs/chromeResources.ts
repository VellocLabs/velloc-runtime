// Test stub for `chrome://resources/js/load_time_data.js`, present only on a chrome:// page: `getBoolean` → false,
// `getString` → '', `data` → {}, anything else undefined.

type LoadTimeDataDict = Record<string, unknown>

class LoadTimeDataStub {
  data: LoadTimeDataDict = {}

  getBoolean(_key: string): boolean {
    return false
  }

  getInteger(_key: string): number {
    return 0
  }

  getString(_key: string): string {
    return ''
  }

  getStringF(_key: string, ..._args: unknown[]): string {
    return ''
  }

  getValue(_key: string): unknown {
    return undefined
  }

  valueExists(_key: string): boolean {
    return false
  }

  isInitialized(): boolean {
    return false
  }

  resetForTesting(_data?: LoadTimeDataDict): void {
    this.data = {}
  }
}

export const loadTimeData = new LoadTimeDataStub()
