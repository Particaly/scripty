'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { writeBackupArchive } = require('../public/preload/backup-archive')
const { validateImportPackage } = require('../public/preload/backup-import')
const { buildImportTarget, commitImportTarget } = require('../public/preload/backup-import-transaction')
const { buildExportPackageFiles } = require('../public/preload/backup-package')
const { LogFileRepository, ManagedScriptRepository } = require('../public/preload/file-repositories')
const { MetadataRepository } = require('../public/preload/metadata-repository')

const SCRIPT_ID = '123e4567-e89b-42d3-a456-426614174020'
const TASK_ID = '123e4567-e89b-42d3-a456-426614174010'

/** Initializes one isolated clean-device data root and returns its fixed repositories. */
function createDevice(root) {
  const metadata = new MetadataRepository(path.join(root, 'data'))
  const scripts = new ManagedScriptRepository(path.join(root, 'scripts'))
  const logs = new LogFileRepository(path.join(root, 'logs'))
  metadata.initialize(); scripts.initialize(); logs.initialize()
  return { metadata, scripts }
}

test('migrates scripts, tasks, settings, and relationships between two clean device roots', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-two-device-'))
  try {
    const sourceRoot = path.join(workspace, '设备 A')
    const targetRoot = path.join(workspace, '设备 B')
    const source = createDevice(sourceRoot)
    const target = createDevice(targetRoot)
    const now = '2026-07-13T00:00:00.000Z'
    const stored = source.scripts.write(SCRIPT_ID, 'javascript', 'console.log("跨设备迁移")\n')
    source.metadata.write('scripts', [{ id: SCRIPT_ID, name: '迁移脚本', language: 'javascript', note: '', ...stored, createdAt: now, updatedAt: now }])
    source.metadata.write('tasks', [{ id: TASK_ID, name: '迁移任务', note: '', scriptId: SCRIPT_ID, interpreter: { kind: 'javascript', executable: 'node' }, args: ['中文 参数'], workingDirectory: null, cron: null, timeoutMs: null, enabled: false, concurrency: { policy: 'forbid', limit: 1 }, createdAt: now, updatedAt: now }])
    source.metadata.write('environments', [])
    const packageSnapshot = buildExportPackageFiles({
      appVersion: '1.0.0', exportedAt: now,
      options: { includeEnvironments: false, includeEnvironmentValues: false, includeSensitiveValues: false },
      envelopes: { scripts: source.metadata.readEnvelope('scripts'), tasks: source.metadata.readEnvelope('tasks'), environments: source.metadata.readEnvelope('environments'), settings: source.metadata.readEnvelope('settings') },
      readScriptContent: script => source.scripts.read(script.id, script.language)
    })
    const archivePath = path.join(workspace, '迁移 backup.zip')
    await writeBackupArchive(packageSnapshot.files, archivePath)
    const validated = await validateImportPackage(archivePath)
    const current = { scripts: target.metadata.read('scripts'), tasks: target.metadata.read('tasks'), environments: target.metadata.read('environments'), settings: target.metadata.read('settings') }
    const targetData = buildImportTarget(validated, current, 'overwrite')
    commitImportTarget(targetRoot, validated, targetData)
    const reopened = createDevice(targetRoot)
    assert.equal(reopened.metadata.read('scripts')[0].id, SCRIPT_ID)
    assert.equal(reopened.metadata.read('tasks')[0].scriptId, SCRIPT_ID)
    assert.equal(reopened.metadata.read('tasks')[0].name, '迁移任务')
    assert.equal(reopened.metadata.read('tasks')[0].interpreter.executable, 'node')
    assert.equal(reopened.scripts.read(SCRIPT_ID, 'javascript'), 'console.log("跨设备迁移")\n')
    fs.rmSync(validated.temporaryDirectory, { recursive: true, force: true })
  } finally { fs.rmSync(workspace, { recursive: true, force: true }) }
})
