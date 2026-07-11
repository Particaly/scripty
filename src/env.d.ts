/// <reference types="vite/client" />
/// <reference types="@ztools-center/ztools-api-types" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

interface ChildProcessProbeResult {
  started: boolean
  childPid: number
  childProcessLogPath: string
}

interface ChildProcessProbeStatus {
  running: boolean
  childPid?: number
  childProcessLogPath: string
}

interface DataPaths {
  root: string
  metadata: string
  scripts: string
  logs: string
  backups: string
}

// Preload services 类型声明（对应 public/preload/services.js）
interface Services {
  dataPaths: {
    ensure: () => DataPaths
  }
  lifecycleProbe: {
    record: (event: string, details?: Record<string, unknown>) => LifecycleProbeEntry
    status: () => LifecycleProbeStatus
    readLog: () => string
    clearLog: () => LifecycleProbeEntry
  }
  childProcessProbe: {
    start: () => ChildProcessProbeResult
    stop: () => boolean
    status: () => ChildProcessProbeStatus
    readLog: () => string
    clearLog: () => void
  }
  readFile: (file: string) => string
  writeTextFile: (text: string) => string
  writeImageFile: (base64Url: string) => string | undefined
}

declare global {
  interface LifecycleProbeEntry {
    timestamp: string
    event: string
    pid: number
    preloadStartedAt: string
    processExit?: boolean
    code?: number
  }

  interface LifecycleProbeStatus {
    lifecycleLogPath: string
    pid: number
    preloadStartedAt: string
  }

  interface Window {
    services: Services
  }
}

export {}
