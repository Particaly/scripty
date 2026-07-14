import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

/** Waits for one terminal run event and rejects when the bundled child-process path does not converge. */
function waitForFinishedRun(api, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Bundled JavaScript run did not finish')) }, timeoutMs)
    const unsubscribe = api.runs.subscribe(event => {
      if (event.type !== 'finished') return
      clearTimeout(timeout)
      unsubscribe()
      resolve(event.record)
    })
  })
}

/** Creates and executes a real two-line JavaScript task through only the bundled public preload API. */
async function smokeJavaScriptRun(api) {
  const finished = waitForFinishedRun(api)
  const script = await api.scripts.create({ name: 'smoke.js', language: 'javascript', note: '', content: 'const a = 1\nconsole.log(a)\n' })
  if (!script.ok) throw new Error(`Smoke script creation failed: ${script.error?.message}`)
  const task = await api.tasks.create({
    name: 'JavaScript smoke', note: '', scriptId: script.data.id,
    interpreter: { kind: 'javascript', executable: process.execPath }, args: [], workingDirectory: null,
    cron: null, timeoutMs: 5000, enabled: false, concurrency: { policy: 'forbid', limit: 1 }
  })
  if (!task.ok) throw new Error(`Smoke task creation failed: ${task.error?.message}`)
  const started = await api.runs.start(task.data.id)
  if (!started.ok) throw new Error(`Smoke task start failed: ${started.error?.message}`)
  const record = await finished
  if (record.status !== 'success' || record.exitCode !== 0) throw new Error(`Smoke task ended as ${record.status}`)
  const history = await api.history.get(record.id)
  const log = await api.history.readLog(record.id, { offset: 0, length: 1024 })
  const active = await api.runs.getActive()
  if (!history.ok || !log.ok || !log.data.content.includes('[stdout] 1\n') || !active.ok || active.data.length !== 0) throw new Error('Bundled JavaScript run artifacts are incomplete')
  return record
}

/** Loads the final preload outside the repository with fresh userData and exercises execution, Cron, and ZIP paths. */
export async function smokePreload(directory, options = {}) {
  const smokeRoot = options.smokeRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-artifact-smoke-'))
  const userData = path.join(smokeRoot, 'user-data')
  const backupPath = path.join(smokeRoot, 'smoke-backup.zip')
  let pluginOutHandler = null
  globalThis.window = {
    ztools: {
      getPath(name) { if (name === 'userData') return userData; if (name === 'downloads') return smokeRoot; throw new Error(`Unexpected path request: ${name}`) },
      onPluginOut(handler) { pluginOutHandler = handler },
      async showOpenDialog() { return [backupPath] },
      async showSaveDialog() { return backupPath }
    }
  }
  try {
    const moduleUrl = `${pathToFileURL(path.join(directory, 'preload/services.js')).href}?smoke=${Date.now()}`
    const loaded = await import(moduleUrl)
    const api = globalThis.window.scripty
    if (!api || !['app', 'backups', 'environments', 'history', 'runs', 'scripts', 'settings', 'tasks'].every(key => api[key])) {
      throw new Error('Preload did not register the complete Scripty API')
    }
    const initialized = await api.settings.get()
    if (!initialized.ok) throw new Error(`Settings initialization failed: ${initialized.error?.message}`)
    await smokeJavaScriptRun(api)
    const schedule = await api.tasks.previewSchedule('*/5 * * * *')
    if (!schedule.ok || !Array.isArray(schedule.data.nextRuns) || schedule.data.nextRuns.length === 0) throw new Error('Bundled Cron parser smoke failed')
    const preview = await api.backups.previewExport({ includeEnvironments: false, includeEnvironmentValues: false, includeSensitiveValues: false })
    if (!preview.ok) throw new Error(`Backup preview failed: ${preview.error?.message}`)
    const exported = await api.backups.export(preview.data.previewToken)
    if (!exported.ok || !fs.existsSync(backupPath)) throw new Error('Bundled ZIP writer smoke failed')
    const imported = await api.backups.chooseImportPackage()
    if (!imported.ok || !imported.data?.validationToken) throw new Error('Bundled ZIP reader smoke failed')
    const committed = await api.backups.import(imported.data.validationToken, { mode: 'merge' })
    if (!committed.ok) throw new Error(`Bundled ZIP import smoke failed: ${committed.error?.message}`)
    pluginOutHandler?.(true)
    loaded.default?.scheduler?.shutdown?.()
    return { userData, backupPath }
  } finally {
    delete globalThis.window
    if (!options.keep) fs.rmSync(smokeRoot, { recursive: true, force: true })
  }
}

/** Runs the dependency-free preload smoke as a CLI for verification after node_modules is removed. */
async function main() {
  const directory = process.argv[2]
  if (!directory || !path.isAbsolute(directory)) throw new Error('Provide an absolute release directory')
  await smokePreload(directory)
  console.log(JSON.stringify({ directory, preloadWithoutNodeModules: 'passed' }, null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main()
