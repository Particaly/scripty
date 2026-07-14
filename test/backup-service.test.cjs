'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const test = require('node:test')
const {
  EXPORT_PREVIEW_TTL_MS,
  IMPORT_VALIDATION_TTL_MS,
  createBackupPreviewStore,
  createBackupsApi,
  createImportPreview,
  createImportValidationStore
} = require('../public/preload/backup-service')
const { RepositoryError } = require('../public/preload/metadata-repository')

const SCRIPT_ID = '123e4567-e89b-42d3-a456-426614174020'
const TASK_ID = '123e4567-e89b-42d3-a456-426614174010'
const ENVIRONMENT_ID = '123e4567-e89b-42d3-a456-426614174030'
const SOURCE = 'console.log("SOURCE_CANARY")\n'

/** Calculates fixture hashes with the same algorithm required by script metadata. */
function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

/** Creates repository and script-reader spies around a valid four-envelope export fixture. */
function createFixture(overrides = {}) {
  const calls = []
  const envelopes = {
    scripts: { schemaVersion: 1, data: [{ id: SCRIPT_ID, name: 'script', managedFileName: `${SCRIPT_ID}.js`, language: 'javascript', contentHash: sha256(SOURCE), note: '', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }] },
    tasks: { schemaVersion: 1, data: [{ id: TASK_ID, name: 'task', note: '', scriptId: SCRIPT_ID, interpreter: { kind: 'javascript', executable: '/DEVICE_NODE_CANARY' }, args: [], workingDirectory: '/DEVICE_WORK_CANARY', cron: null, timeoutMs: null, enabled: true, concurrency: { policy: 'forbid', limit: 1 }, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }] },
    environments: { schemaVersion: 1, data: [{ id: ENVIRONMENT_ID, name: 'ENV_NAME_CANARY', value: 'ENV_VALUE_CANARY', note: '', scope: 'global', taskId: null, enabled: true, sensitive: true, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }] },
    settings: { schemaVersion: 1, data: { defaultTimeoutMs: 300000, defaultConcurrency: { policy: 'forbid', limit: 1 }, logRetention: { maxRunsPerTask: 100, maxAgeDays: 30 }, defaultInterpreters: { javascript: '/DEVICE_DEFAULT_CANARY', python: null, powershell: null, shell: null }, defaultWorkingDirectory: null, schedulerNoticeAcknowledged: false, updatedAt: '2026-07-12T00:00:00.000Z' } }
  }
  const metadataRepository = {
    readEnvelope(name) { calls.push(['envelope', name]); return envelopes[name] },
    readAll() { calls.push(['readAll']); throw new Error('must not read all repositories') }
  }
  const managedScriptRepository = {
    read(id, language) { calls.push(['script', id, language]); return SOURCE }
  }
  return { calls, envelopes, metadataRepository, managedScriptRepository, ...overrides }
}

/** Creates a deterministic one-slot store with manually triggered timers. */
function createStoreHarness() {
  let currentTime = 1000
  let nextTimer = 0
  const timers = new Map()
  const store = createBackupPreviewStore({
    now: () => currentTime,
    setTimer(callback) { nextTimer += 1; timers.set(nextTimer, callback); return nextTimer },
    clearTimer(id) { timers.delete(id) }
  })
  return {
    store,
    setTime(value) { currentTime = value },
    fire(id) { timers.get(id)?.() },
    timerIds() { return [...timers.keys()] }
  }
}

test('previews all four export scopes from exactly four repositories without leaking package content', async () => {
  const scopes = [
    [{ includeEnvironments: false, includeEnvironmentValues: false, includeSensitiveValues: false }, 0, '未选择环境变量'],
    [{ includeEnvironments: true, includeEnvironmentValues: false, includeSensitiveValues: false }, 1, '仅包含环境变量定义'],
    [{ includeEnvironments: true, includeEnvironmentValues: true, includeSensitiveValues: false }, 1, '包含未标记为敏感']
  ]
  for (const [scope, environmentCount, warningFragment] of scopes) {
    const fixture = createFixture()
    const harness = createStoreHarness()
    const api = createBackupsApi(fixture.metadataRepository, fixture.managedScriptRepository, {
      appVersion: '1.0.0',
      now: () => Date.parse('2026-07-12T08:00:00.000Z'),
      previewStore: harness.store
    })
    const result = await api.previewExport(scope)
    assert.equal(result.ok, true)
    assert.equal(result.data.manifest.entities.environments, environmentCount)
    assert.equal(result.data.expiresAt, '2026-07-12T08:05:00.000Z')
    assert.ok(result.data.warnings.some(warning => warning.includes(warningFragment)))
    assert.deepEqual(fixture.calls, [
      ['envelope', 'scripts'], ['envelope', 'tasks'], ['envelope', 'environments'], ['envelope', 'settings'],
      ['script', SCRIPT_ID, 'javascript']
    ])
    const responseText = JSON.stringify(result)
    for (const canary of ['ENV_NAME_CANARY', 'ENV_VALUE_CANARY', 'SOURCE_CANARY', '/DEVICE_NODE_CANARY', '/DEVICE_WORK_CANARY', '/DEVICE_DEFAULT_CANARY']) {
      assert.equal(responseText.includes(canary), false, `preview leaked ${canary}`)
    }
    assert.deepEqual(Object.keys(result.data), ['previewToken', 'expiresAt', 'manifest', 'warnings'])
    assert.equal(Object.hasOwn(result.data.manifest, 'files'), false)
  }
})

test('requires an exact confirmation before reading or caching sensitive values', async () => {
  for (const confirmation of [undefined, {}, { acknowledgedPlaintextRisk: false }, { acknowledgedPlaintextRisk: 1 }, [], Object.create({ acknowledgedPlaintextRisk: true }), { acknowledgedPlaintextRisk: true, extra: true }]) {
    const fixture = createFixture()
    const harness = createStoreHarness()
    const api = createBackupsApi(fixture.metadataRepository, fixture.managedScriptRepository, {
      appVersion: '1.0.0', now: () => 1000, previewStore: harness.store
    })
    const result = await api.previewExport(
      { includeEnvironments: true, includeEnvironmentValues: true, includeSensitiveValues: true },
      confirmation
    )
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'CONFIRMATION_REQUIRED')
    assert.deepEqual(fixture.calls, [])
    assert.throws(() => harness.store.resolve('anything'), error => error.code === 'TOKEN_INVALID')
  }

  const fixture = createFixture()
  const harness = createStoreHarness()
  const api = createBackupsApi(fixture.metadataRepository, fixture.managedScriptRepository, {
    appVersion: '1.0.0', now: () => 1000, previewStore: harness.store
  })
  const accepted = await api.previewExport(
    { includeEnvironments: true, includeEnvironmentValues: true, includeSensitiveValues: true },
    { acknowledgedPlaintextRisk: true }
  )
  assert.equal(accepted.ok, true)
  assert.equal(accepted.data.manifest.options.includeSensitiveValues, true)
  assert.equal(JSON.stringify(accepted).includes('ENV_VALUE_CANARY'), false)
})

test('exposes only previewExport and invalidates the old snapshot before a failing replacement', async () => {
  const fixture = createFixture()
  const harness = createStoreHarness()
  let tokenIndex = 0
  const api = createBackupsApi(fixture.metadataRepository, fixture.managedScriptRepository, {
    appVersion: '1.0.0', now: () => 1000, randomUUID: () => `token-${++tokenIndex}`, previewStore: harness.store
  })
  assert.deepEqual(Object.keys(api), ['previewExport', 'export', 'chooseImportPackage', 'import'])
  const scope = { includeEnvironments: false, includeEnvironmentValues: false, includeSensitiveValues: false }
  const first = await api.previewExport(scope)
  assert.equal(first.ok, true)
  assert.equal(harness.store.resolve(first.data.previewToken).manifest.formatVersion, '1.0')
  fixture.envelopes.scripts.data[0].contentHash = '0'.repeat(64)
  const failed = await api.previewExport(scope)
  assert.equal(failed.ok, false)
  assert.throws(() => harness.store.resolve(first.data.previewToken), error => error.code === 'TOKEN_INVALID')
})

test('exports immutable previews once and returns an authoritative save summary', async () => {
  const fixture = createFixture()
  const harness = createStoreHarness()
  const dialogs = []
  const writes = []
  const api = createBackupsApi(fixture.metadataRepository, fixture.managedScriptRepository, {
    appVersion: '1.0.0',
    now: () => 1000,
    randomUUID: () => 'export-token',
    previewStore: harness.store,
    ztools: { showSaveDialog(options) { dialogs.push(options); return '/private/output/Scripty 中文.zip' } },
    async writeBackupArchive(files, targetPath) { writes.push({ files, targetPath }); return 4321 }
  })
  const previewResult = await api.previewExport({ includeEnvironments: false, includeEnvironmentValues: false, includeSensitiveValues: false })
  assert.equal(previewResult.ok, true)
  fixture.envelopes.scripts.data = []
  fixture.calls.length = 0
  const exported = await api.export(previewResult.data.previewToken)
  assert.deepEqual(exported.data, { displayName: 'Scripty 中文.zip', size: 4321, containsSensitiveValues: false })
  assert.equal(dialogs.length, 1)
  assert.deepEqual(dialogs[0].filters, [{ name: 'ZIP 备份包', extensions: ['zip'] }])
  assert.equal(writes.length, 1)
  assert.equal(writes[0].targetPath, '/private/output/Scripty 中文.zip')
  assert.ok(writes[0].files.some(file => file.path === 'manifest.json'))
  assert.deepEqual(fixture.calls, [])
  const reused = await api.export(previewResult.data.previewToken)
  assert.equal(reused.ok, false)
  assert.equal(reused.error.code, 'TOKEN_INVALID')
})

test('revalidates sensitive confirmation before dialog and consumes valid attempts on cancel or failure', async () => {
  const fixture = createFixture()
  const harness = createStoreHarness()
  let dialogCalls = 0
  let writerCalls = 0
  let cancel = true
  const api = createBackupsApi(fixture.metadataRepository, fixture.managedScriptRepository, {
    appVersion: '1.0.0',
    now: () => 1000,
    previewStore: harness.store,
    ztools: { showSaveDialog() { dialogCalls += 1; return cancel ? undefined : '/tmp/backup.zip' } },
    async writeBackupArchive() { writerCalls += 1; throw new RepositoryError('DISK_FULL', '无法写入备份文件') }
  })
  const scope = { includeEnvironments: true, includeEnvironmentValues: true, includeSensitiveValues: true }
  const confirmation = { acknowledgedPlaintextRisk: true }
  const first = await api.previewExport(scope, confirmation)
  const unconfirmed = await api.export(first.data.previewToken)
  assert.equal(unconfirmed.ok, false)
  assert.equal(unconfirmed.error.code, 'CONFIRMATION_REQUIRED')
  assert.equal(dialogCalls, 0)
  const cancelled = await api.export(first.data.previewToken, confirmation)
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.data, null)
  assert.equal(dialogCalls, 1)
  assert.equal(writerCalls, 0)
  assert.equal((await api.export(first.data.previewToken, confirmation)).error.code, 'TOKEN_INVALID')

  cancel = false
  const second = await api.previewExport(scope, confirmation)
  const failed = await api.export(second.data.previewToken, confirmation)
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'DISK_FULL')
  assert.equal(writerCalls, 1)
  assert.equal((await api.export(second.data.previewToken, confirmation)).error.code, 'TOKEN_INVALID')
})

test('builds stable-ID merge and overwrite previews without leaking entity content', () => {
  const fixture = createFixture()
  const imported = structuredClone({
    scripts: fixture.envelopes.scripts,
    tasks: fixture.envelopes.tasks,
    environments: fixture.envelopes.environments,
    settings: { schemaVersion: 1, data: { defaultTimeoutMs: 300000, defaultConcurrency: { policy: 'forbid', limit: 1 }, logRetention: { maxRunsPerTask: 100, maxAgeDays: 30 }, updatedAt: '2026-07-12T00:00:00.000Z' } }
  })
  imported.tasks.data[0].interpreter.executable = null
  imported.tasks.data[0].workingDirectory = null
  imported.environments.data[0].value = ''
  imported.environments.data[0].valueIncluded = false
  imported.scripts.data.push({ ...imported.scripts.data[0], id: '123e4567-e89b-42d3-a456-426614174099', managedFileName: '123e4567-e89b-42d3-a456-426614174099.js' })
  const localOnlyTask = { ...fixture.envelopes.tasks.data[0], id: '123e4567-e89b-42d3-a456-426614174098', name: 'local only' }
  const local = { ...fixture.envelopes, tasks: { schemaVersion: 1, data: [...fixture.envelopes.tasks.data, localOnlyTask] } }
  const preview = createImportPreview({
    manifest: {
      formatVersion: '1.0', appVersion: '1.0.0', exportedAt: '2026-07-12T08:00:00.000Z',
      entities: { scripts: 2, tasks: 1, environments: 1 },
      options: { includeEnvironments: true, includeEnvironmentValues: false, includeSensitiveValues: false }
    },
    documents: imported
  }, local, 'validation-token', 2000)

  assert.equal(preview.merge.scripts.added, 1)
  assert.equal(preview.merge.scripts.conflicts, 1)
  assert.equal(preview.merge.tasks.retained, 2)
  assert.equal(preview.overwrite.tasks.deleted, 1)
  assert.equal(preview.merge.environments.updated, 0)
  assert.equal(preview.merge.environments.retained, 1)
  assert.equal(preview.merge.settings.retained, 1)
  const responseText = JSON.stringify(preview)
  for (const canary of ['SOURCE_CANARY', 'ENV_VALUE_CANARY', '/DEVICE_NODE_CANARY', '/DEVICE_WORK_CANARY', '/DEVICE_DEFAULT_CANARY']) {
    assert.equal(responseText.includes(canary), false, `import preview leaked ${canary}`)
  }
})

test('selects and validates an import ZIP while returning only a temporary token', async () => {
  const fixture = createFixture()
  const importCalls = []
  const removed = []
  let currentTime = 1000
  const importStore = createImportValidationStore({ now: () => currentTime, setTimer: () => 1, clearTimer() {}, removeSnapshot: snapshot => removed.push(snapshot.temporaryDirectory) })
  const api = createBackupsApi(fixture.metadataRepository, fixture.managedScriptRepository, {
    appVersion: '1.0.0', now: () => currentTime, randomUUID: () => 'validation-token', importStore,
    ztools: { showOpenDialog(options) { importCalls.push(options); return ['/private/中文 package.zip'] } },
    async validateImportPackage(selectedPath) {
      assert.equal(selectedPath, '/private/中文 package.zip')
      const documents = structuredClone(fixture.envelopes)
      documents.tasks.data[0].interpreter.executable = null
      documents.tasks.data[0].workingDirectory = null
      documents.environments.data[0] = { ...documents.environments.data[0], value: '', valueIncluded: false }
      documents.settings.data = { defaultTimeoutMs: 300000, defaultConcurrency: { policy: 'forbid', limit: 1 }, logRetention: { maxRunsPerTask: 100, maxAgeDays: 30 }, updatedAt: '2026-07-12T00:00:00.000Z' }
      return {
        temporaryDirectory: '/tmp/private-staging',
        manifest: {
          formatVersion: '1.0', appVersion: '1.0.0', exportedAt: '2026-07-12T08:00:00.000Z',
          entities: { scripts: 1, tasks: 1, environments: 1 },
          options: { includeEnvironments: true, includeEnvironmentValues: false, includeSensitiveValues: false }
        },
        documents
      }
    }
  })
  const result = await api.chooseImportPackage()
  assert.equal(result.ok, true)
  assert.equal(result.data.validationToken, 'validation-token')
  assert.equal(result.data.expiresAt, new Date(1000 + IMPORT_VALIDATION_TTL_MS).toISOString())
  assert.deepEqual(Object.keys(result.data), ['validationToken', 'expiresAt', 'package', 'merge', 'overwrite', 'warnings'])
  assert.deepEqual(importCalls[0].filters, [{ name: 'ZIP 备份包', extensions: ['zip'] }])
  assert.equal(JSON.stringify(result).includes('/private/'), false)
  assert.equal(importStore.resolve('validation-token').temporaryDirectory, '/tmp/private-staging')
  currentTime += IMPORT_VALIDATION_TTL_MS
  assert.throws(() => importStore.resolve('validation-token'), error => error.code === 'TOKEN_EXPIRED')
  assert.deepEqual(removed, ['/tmp/private-staging'])
})

test('handles import-picker cancellation and failed validation without issuing a token', async () => {
  const fixture = createFixture()
  const removed = []
  const importStore = createImportValidationStore({ setTimer: () => 1, clearTimer() {}, removeSnapshot: snapshot => removed.push(snapshot.temporaryDirectory) })
  let selection
  const api = createBackupsApi(fixture.metadataRepository, fixture.managedScriptRepository, {
    appVersion: '1.0.0', importStore,
    ztools: { showOpenDialog() { return selection } },
    async validateImportPackage() { throw new RepositoryError('PACKAGE_INVALID', '备份包校验失败') }
  })
  const cancelled = await api.chooseImportPackage()
  assert.equal(cancelled.ok, true); assert.equal(cancelled.data, null)
  selection = ['/private/broken.zip']
  const failed = await api.chooseImportPackage()
  assert.equal(failed.ok, false); assert.equal(failed.error.code, 'PACKAGE_INVALID')
  assert.throws(() => importStore.resolve('anything'), error => error.code === 'TOKEN_INVALID')
  assert.deepEqual(removed, [])
})

test('consumes a validated package once and applies the selected transaction mode', async () => {
  const fixture = createFixture()
  const removed = []
  const snapshot = {
    temporaryDirectory: '/tmp/import-staging',
    manifest: {
      formatVersion: '1.0', appVersion: '1.0.0', exportedAt: '2026-07-13T00:00:00.000Z',
      entities: { scripts: 1, tasks: 1, environments: 1 },
      options: { includeEnvironments: true, includeEnvironmentValues: false, includeSensitiveValues: false }
    },
    documents: structuredClone(fixture.envelopes)
  }
  snapshot.documents.tasks.data[0].interpreter.executable = null
  snapshot.documents.tasks.data[0].workingDirectory = null
  snapshot.documents.environments.data[0] = { ...snapshot.documents.environments.data[0], value: '', valueIncluded: false }
  snapshot.documents.settings.data = { defaultTimeoutMs: 300000, defaultConcurrency: { policy: 'forbid', limit: 1 }, logRetention: { maxRunsPerTask: 100, maxAgeDays: 30 }, updatedAt: '2026-07-12T00:00:00.000Z' }
  const importStore = createImportValidationStore({ setTimer: () => 1, clearTimer() {}, removeSnapshot: value => removed.push(value.temporaryDirectory) })
  importStore.replace('import-token', snapshot, Date.now() + 60000)
  const scheduleCalls = []
  const commits = []
  fixture.metadataRepository.read = name => fixture.envelopes[name].data
  const api = createBackupsApi(fixture.metadataRepository, fixture.managedScriptRepository, {
    appVersion: '1.0.0', dataRoot: '/private/scripty', importStore,
    scheduler: {
      prepareSnapshot(tasks) { scheduleCalls.push(['prepare', tasks]); return { state: 'prepared' } },
      commitSnapshot(change) { scheduleCalls.push(['commit', change]) },
      abortSnapshot(change) { scheduleCalls.push(['abort', change]) }
    },
    commitImportTarget(root, value, target) { commits.push({ root, value, target }) }
  })
  const result = await api.import('import-token', { mode: 'merge' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.data.mode, 'merge')
  assert.equal(commits.length, 1)
  assert.equal(commits[0].root, '/private/scripty')
  assert.equal(commits[0].target.environments[0].value, 'ENV_VALUE_CANARY')
  assert.deepEqual(scheduleCalls.map(call => call[0]), ['prepare', 'commit'])
  assert.equal((await api.import('import-token', { mode: 'merge' })).error.code, 'TOKEN_INVALID')
  assert.deepEqual(removed, [])
})

test('requires overwrite confirmation and creates an automatic backup before consuming import state', async () => {
  const fixture = createFixture()
  const snapshot = { temporaryDirectory: '/tmp/overwrite-staging', manifest: { options: {} }, documents: {} }
  const importStore = {
    consume() { throw new Error('must not consume before confirmation and backup') },
    clear() {}
  }
  let backups = 0
  const api = createBackupsApi(fixture.metadataRepository, fixture.managedScriptRepository, {
    appVersion: '1.0.0', dataRoot: '/private/scripty', importStore,
    scheduler: { prepareSnapshot() {} },
    async createAutomaticBackup() { backups += 1; throw new RepositoryError('DISK_FULL', '自动备份失败') }
  })
  const unconfirmed = await api.import('token', { mode: 'overwrite' })
  assert.equal(unconfirmed.error.code, 'CONFIRMATION_REQUIRED')
  assert.equal(backups, 0)
  const failedBackup = await api.import('token', { mode: 'overwrite' }, { acknowledgedOverwriteRisk: true })
  assert.equal(failedBackup.error.code, 'DISK_FULL')
  assert.equal(backups, 1)
  assert.equal(snapshot.temporaryDirectory, '/tmp/overwrite-staging')
})

test('expires one preview after five minutes and prevents old timers from deleting replacements', () => {
  const harness = createStoreHarness()
  harness.store.replace('first', { marker: 1 }, 1000 + EXPORT_PREVIEW_TTL_MS)
  const firstTimer = harness.timerIds()[0]
  harness.store.replace('second', { marker: 2 }, 1000 + EXPORT_PREVIEW_TTL_MS)
  assert.equal(harness.store.resolve('second').marker, 2)
  harness.fire(firstTimer)
  assert.equal(harness.store.resolve('second').marker, 2)
  harness.setTime(1000 + EXPORT_PREVIEW_TTL_MS)
  assert.throws(() => harness.store.resolve('second'), error => error.code === 'TOKEN_EXPIRED')
})

test('returns structured validation and masked internal failures without issuing usable snapshots', async () => {
  const fixture = createFixture()
  const harness = createStoreHarness()
  const api = createBackupsApi(fixture.metadataRepository, fixture.managedScriptRepository, {
    appVersion: '1.0.0', now: () => 1000, previewStore: harness.store
  })
  const invalid = await api.previewExport({ includeEnvironments: false, includeEnvironmentValues: true, includeSensitiveValues: false })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'VALIDATION_ERROR')

  fixture.metadataRepository.readEnvelope = () => { throw new Error('/private/SECRET_PATH_CANARY') }
  const internal = await api.previewExport({ includeEnvironments: false, includeEnvironmentValues: false, includeSensitiveValues: false })
  assert.equal(internal.ok, false)
  assert.equal(internal.error.code, 'INTERNAL_ERROR')
  assert.equal(JSON.stringify(internal).includes('SECRET_PATH_CANARY'), false)
})
