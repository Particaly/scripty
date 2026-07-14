'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  LogFileRepository,
  ManagedScriptRepository
} = require('./file-repositories')
const {
  MetadataRepository,
  RepositoryError
} = require('./metadata-repository')
const { createAppApi } = require('./app-service')
const { writeBackupArchive } = require('./backup-archive')
const { buildExportPackageFiles } = require('./backup-package')
const { createBackupsApi } = require('./backup-service')
const { recoverImportTransactions } = require('./backup-import-transaction')
const { createEnvironmentsApi } = require('./environment-service')
const { createHistoryApi } = require('./history-service')
const { createInterpreterResolver } = require('./interpreter-resolver')
const { createRunService, recoverInterruptedRuns } = require('./run-service')
const { createSchedulerService, registerSchedulerLifecycle } = require('./scheduler-service')
const { createScriptsApi } = require('./script-service')
const { createSettingsApi } = require('./settings-service')
const { createTasksApi } = require('./task-service')

/** Resolves Scripty's fixed device-local directory layout from the ZTools user data path. */
function getDataPaths() {
  const root = path.join(window.ztools.getPath('userData'), 'scripty')
  return {
    root,
    metadata: path.join(root, 'data'),
    scripts: path.join(root, 'scripts'),
    logs: path.join(root, 'logs'),
    backups: path.join(root, 'backups')
  }
}

const dataPaths = getDataPaths()
recoverImportTransactions(dataPaths.root)
const metadataRepository = new MetadataRepository(dataPaths.metadata)
const managedScriptRepository = new ManagedScriptRepository(dataPaths.scripts)
const logFileRepository = new LogFileRepository(dataPaths.logs)
metadataRepository.initialize()
managedScriptRepository.initialize()
logFileRepository.initialize()
recoverInterruptedRuns(metadataRepository)

const interpreterResolver = createInterpreterResolver({
  platform: process.platform,
  environment: process.env,
  homeDirectory: os.homedir()
})
const runService = createRunService(metadataRepository, managedScriptRepository, logFileRepository, undefined, process.platform, undefined, interpreterResolver)
const scheduler = createSchedulerService({ startScheduledRun: runService.startScheduled })
scheduler.initialize(metadataRepository.read('tasks'))
registerSchedulerLifecycle(window.ztools, scheduler)
const tasksApi = createTasksApi(metadataRepository, managedScriptRepository, scheduler, interpreterResolver)

/** Creates a timestamped full portable backup in the fixed backups directory before overwrite restoration. */
async function createAutomaticBackup() {
  const exportedAt = new Date().toISOString()
  const packageSnapshot = buildExportPackageFiles({
    appVersion: require('../plugin.json').version,
    exportedAt,
    options: { includeEnvironments: true, includeEnvironmentValues: true, includeSensitiveValues: true },
    envelopes: {
      scripts: metadataRepository.readEnvelope('scripts'),
      tasks: metadataRepository.readEnvelope('tasks'),
      environments: metadataRepository.readEnvelope('environments'),
      settings: metadataRepository.readEnvelope('settings')
    },
    readScriptContent: script => managedScriptRepository.read(script.id, script.language)
  })
  fs.mkdirSync(dataPaths.backups, { recursive: true })
  const fileName = `pre-overwrite-${exportedAt.replace(/[:.]/g, '-')}.zip`
  await writeBackupArchive(packageSnapshot.files, path.join(dataPaths.backups, fileName))
  return fileName
}

window.scripty = {
  app: createAppApi(scheduler),
  backups: createBackupsApi(metadataRepository, managedScriptRepository, {
    appVersion: require('../plugin.json').version,
    createAutomaticBackup,
    dataRoot: dataPaths.root,
    scheduler,
    ztools: window.ztools
  }),
  environments: createEnvironmentsApi(metadataRepository, window.ztools),
  history: createHistoryApi(metadataRepository, logFileRepository, runService.api),
  runs: runService.api,
  scripts: createScriptsApi(metadataRepository, managedScriptRepository, window.ztools),
  settings: createSettingsApi(metadataRepository, window.ztools),
  tasks: tasksApi
}

module.exports = {
  dataPaths,
  logFileRepository,
  managedScriptRepository,
  metadataRepository,
  RepositoryError,
  scheduler
}
