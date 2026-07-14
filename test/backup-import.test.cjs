'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createHash } = require('node:crypto')
const { writeBackupArchive } = require('../public/preload/backup-archive')
const { buildExportPackageFiles } = require('../public/preload/backup-package')
const { validateImportDocuments, validateImportManifest, validateImportPackage } = require('../public/preload/backup-import')
const { isAllowedPackagePath } = require('../public/preload/backup-protocol')

const SCRIPT_ID = '123e4567-e89b-42d3-a456-426614174020'
const TASK_ID = '123e4567-e89b-42d3-a456-426614174010'
const SOURCE = 'console.log("中文 import")\n'

/** Calculates fixture SHA-256 values with the production algorithm. */
function sha256(content) { return createHash('sha256').update(content).digest('hex') }

/** Builds a valid portable logical package for import validation tests. */
function createPackage() {
  return buildExportPackageFiles({
    appVersion: '1.0.0', exportedAt: '2026-07-12T08:00:00.000Z',
    options: { includeEnvironments: true, includeEnvironmentValues: true, includeSensitiveValues: false },
    envelopes: {
      scripts: { schemaVersion: 1, data: [{ id: SCRIPT_ID, name: 'script', managedFileName: `${SCRIPT_ID}.js`, language: 'javascript', contentHash: sha256(SOURCE), note: '', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }] },
      tasks: { schemaVersion: 1, data: [{ id: TASK_ID, name: 'task', note: '', scriptId: SCRIPT_ID, interpreter: { kind: 'javascript', executable: '/device/node' }, args: [], workingDirectory: '/device/work', cron: null, timeoutMs: null, enabled: true, concurrency: { policy: 'forbid', limit: 1 }, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }] },
      environments: { schemaVersion: 1, data: [{ id: '123e4567-e89b-42d3-a456-426614174030', name: 'MODE', value: 'normal', note: '', scope: 'global', taskId: null, enabled: true, sensitive: false, createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }] },
      settings: { schemaVersion: 1, data: { defaultTimeoutMs: 300000, defaultConcurrency: { policy: 'forbid', limit: 1 }, logRetention: { maxRunsPerTask: 100, maxAgeDays: 30 }, defaultInterpreters: { javascript: '/device/node', python: null, powershell: null, shell: null }, defaultWorkingDirectory: '/device/work', schedulerNoticeAcknowledged: false, updatedAt: '2026-07-12T00:00:00.000Z' } }
    },
    readScriptContent: () => SOURCE
  })
}

/** Writes logical package files to a disposable ZIP path containing spaces and Chinese characters. */
async function writeFixture(packageSnapshot, t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty import 中文-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const archivePath = path.join(directory, 'backup package 中文.zip')
  await writeBackupArchive(packageSnapshot.files, archivePath)
  return archivePath
}

/** Recomputes serialized data files and manifest rows after mutating a logical fixture. */
function refreshPackage(snapshot, names = ['scripts', 'tasks', 'environments', 'settings']) {
  for (const name of names) {
    const file = snapshot.files.find(item => item.path === `data/${name}.json`)
    file.content = Buffer.from(`${JSON.stringify(snapshot.data[name], null, 2)}\n`)
    const row = snapshot.manifest.files.find(item => item.path === file.path)
    row.size = file.content.length
    row.sha256 = sha256(file.content)
  }
  snapshot.files[0].content = Buffer.from(`${JSON.stringify(snapshot.manifest, null, 2)}\n`)
  return snapshot
}

/** Creates the validated document and hash inputs used by pure domain-validation tests. */
function createDocumentFixture() {
  const snapshot = createPackage()
  return {
    manifest: snapshot.manifest,
    documents: structuredClone(snapshot.data),
    hashes: new Map(snapshot.files.slice(1).map(file => [file.path, sha256(file.content)]))
  }
}

test('round-trips a portable export into a private validated import snapshot', async (t) => {
  const archivePath = await writeFixture(createPackage(), t)
  const snapshot = await validateImportPackage(archivePath)
  t.after(() => fs.rmSync(snapshot.temporaryDirectory, { recursive: true, force: true }))
  assert.equal(snapshot.manifest.formatVersion, '1.0')
  assert.equal(snapshot.documents.scripts.data.length, 1)
  assert.equal(snapshot.documents.tasks.data[0].interpreter.executable, null)
  assert.equal(snapshot.documents.tasks.data[0].workingDirectory, null)
  assert.ok(snapshot.temporaryDirectory.startsWith(os.tmpdir()))
  assert.equal(fs.readFileSync(path.join(snapshot.temporaryDirectory, 'scripts', `${SCRIPT_ID}.js`), 'utf8'), SOURCE)
})

test('rejects unsupported versions and malformed required manifest fields', () => {
  const valid = createPackage().manifest
  for (const formatVersion of ['1.1', '2.0', '0.9']) {
    assert.throws(() => validateImportManifest({ ...valid, formatVersion }), error => error.code === 'UNSUPPORTED_EXPORT_VERSION')
  }
  const missing = { ...valid }; delete missing.files
  assert.throws(() => validateImportManifest(missing), error => error.code === 'PACKAGE_INVALID')
  assert.throws(() => validateImportManifest({ ...valid, unknown: true }), error => error.code === 'PACKAGE_INVALID')
  assert.throws(() => validateImportManifest({ ...valid, files: [...valid.files].reverse() }), error => error.code === 'PACKAGE_INVALID')
})

test('rejects manifest hash mismatches and cleans partial staging data', async (t) => {
  const snapshot = createPackage()
  const manifest = JSON.parse(snapshot.files[0].content.toString('utf8'))
  manifest.files[0].sha256 = '0'.repeat(64)
  snapshot.files[0].content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const archivePath = await writeFixture(snapshot, t)
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('scripty-import-')))
  await assert.rejects(validateImportPackage(archivePath), error => error.code === 'HASH_MISMATCH')
  const after = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('scripty-import-') && !before.has(name))
  assert.deepEqual(after, [])
})

test('rejects script metadata hashes that disagree with validated ZIP bytes', async (t) => {
  const snapshot = createPackage()
  const scriptsFile = snapshot.files.find(file => file.path === 'data/scripts.json')
  const scripts = JSON.parse(scriptsFile.content.toString('utf8'))
  scripts.data[0].contentHash = 'f'.repeat(64)
  scriptsFile.content = Buffer.from(`${JSON.stringify(scripts, null, 2)}\n`)
  const manifest = snapshot.manifest
  const row = manifest.files.find(file => file.path === scriptsFile.path)
  row.size = scriptsFile.content.length; row.sha256 = sha256(scriptsFile.content)
  snapshot.files[0].content = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const archivePath = await writeFixture(snapshot, t)
  await assert.rejects(validateImportPackage(archivePath), error => error.code === 'HASH_MISMATCH')
})

test('rejects missing, extra, and malformed portable entity fields', () => {
  const mutations = [
    fixture => { delete fixture.documents.scripts.data[0].name },
    fixture => { fixture.documents.scripts.data[0].unknown = true },
    fixture => { fixture.documents.scripts.data[0].createdAt = '2026-07-12' },
    fixture => { delete fixture.documents.tasks.data[0].timeoutMs },
    fixture => { fixture.documents.tasks.data[0].interpreter.extra = true },
    fixture => { fixture.documents.tasks.data[0].timeoutMs = 999 },
    fixture => { fixture.documents.tasks.data[0].concurrency = { policy: 'forbid', limit: 2 } },
    fixture => { delete fixture.documents.environments.data[0].note },
    fixture => { fixture.documents.environments.data[0].updatedAt = 'invalid' },
    fixture => { fixture.documents.settings.data.defaultTimeoutMs = 0 },
    fixture => { fixture.documents.settings.data.logRetention.maxAgeDays = 0 },
    fixture => { fixture.documents.settings.data.logRetention.extra = true },
    fixture => { fixture.documents.settings.data.updatedAt = '2026-07-12T00:00:00Z' }
  ]
  for (const mutate of mutations) {
    const fixture = createDocumentFixture()
    mutate(fixture)
    assert.throws(
      () => validateImportDocuments(fixture.manifest, fixture.documents, fixture.hashes),
      error => error.code === 'PACKAGE_INVALID'
    )
  }
})

test('rejects non-canonical and escaping protocol paths before ZIP extraction', () => {
  for (const invalidPath of [
    '../manifest.json',
    '/manifest.json',
    'C:/manifest.json',
    'data\\scripts.json',
    'data/../scripts.json',
    'data//scripts.json',
    './manifest.json',
    'logs/run.log',
    `scripts/${SCRIPT_ID}.JS`,
    `scripts/${SCRIPT_ID}.js/child`
  ]) {
    assert.equal(isAllowedPackagePath(invalidPath), false, invalidPath)
  }
  for (const validPath of ['manifest.json', 'data/scripts.json', `scripts/${SCRIPT_ID}.js`]) {
    assert.equal(isAllowedPackagePath(validPath), true, validPath)
  }
})

test('rejects symlink package selections without issuing staged data', async (t) => {
  const archivePath = await writeFixture(createPackage(), t)
  const linkedPath = path.join(path.dirname(archivePath), 'linked backup.zip')
  try {
    fs.symlinkSync(archivePath, linkedPath)
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return
    throw error
  }
  await assert.rejects(validateImportPackage(linkedPath), error => error.code === 'PATH_NOT_ALLOWED')
})

test('rejects illegal option projections, dangling references, and entity count mismatches', async (t) => {
  for (const mutate of [
    (pkg) => { pkg.data.environments.data[0].valueIncluded = false },
    (pkg) => { pkg.data.tasks.data[0].scriptId = '123e4567-e89b-42d3-a456-426614174099' },
    (pkg) => { pkg.manifest.entities.tasks = 2 }
  ]) {
    const snapshot = createPackage(); mutate(snapshot)
    refreshPackage(snapshot, ['environments', 'tasks'])
    const archivePath = await writeFixture(snapshot, t)
    await assert.rejects(validateImportPackage(archivePath), error => error.code === 'PACKAGE_INVALID')
  }
})
