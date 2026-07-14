'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createHash } = require('node:crypto')
const { buildImportTarget, commitImportTarget, materializeEnvironments } = require('../public/preload/backup-import-transaction')

const SCRIPT_ID = '123e4567-e89b-42d3-a456-426614174020'
const TASK_ID = '123e4567-e89b-42d3-a456-426614174010'
const SOURCE = 'console.log("import transaction")\n'

/** Calculates fixture hashes with the production SHA-256 representation. */
function sha256(content) { return createHash('sha256').update(content).digest('hex') }

/** Creates current local data and a validated import snapshot with one updated entity of each kind. */
function createFixture(root) {
  const timestamp = '2026-07-13T00:00:00.000Z'
  const script = { id: SCRIPT_ID, name: 'script', managedFileName: `${SCRIPT_ID}.js`, language: 'javascript', contentHash: sha256(SOURCE), note: '', createdAt: timestamp, updatedAt: timestamp }
  const task = { id: TASK_ID, name: 'task', note: '', scriptId: SCRIPT_ID, interpreter: { kind: 'javascript', executable: '/local/node' }, args: [], workingDirectory: '/local/work', cron: null, timeoutMs: null, enabled: true, concurrency: { policy: 'forbid', limit: 1 }, createdAt: timestamp, updatedAt: timestamp }
  const variable = { id: '123e4567-e89b-42d3-a456-426614174030', name: 'TOKEN', value: 'local-secret', note: '', scope: 'global', taskId: null, enabled: true, sensitive: true, createdAt: timestamp, updatedAt: timestamp }
  const settings = { defaultTimeoutMs: 300000, defaultConcurrency: { policy: 'forbid', limit: 1 }, logRetention: { maxRunsPerTask: 100, maxAgeDays: 30 }, defaultInterpreters: { javascript: '/default/node', python: null, powershell: null, shell: null }, defaultWorkingDirectory: '/default/work', schedulerNoticeAcknowledged: true, updatedAt: timestamp }
  const staging = path.join(root, 'staging')
  fs.mkdirSync(path.join(staging, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(staging, 'scripts', `${SCRIPT_ID}.js`), SOURCE)
  return {
    current: { scripts: [script], tasks: [task], environments: [variable], settings },
    snapshot: { temporaryDirectory: staging, documents: {
      scripts: { data: [{ ...script, name: 'imported script' }] },
      tasks: { data: [{ ...task, name: 'imported task', interpreter: { kind: 'javascript', executable: null }, workingDirectory: null, enabled: false }] },
      environments: { data: [{ ...variable, value: '', valueIncluded: false, note: 'imported note' }] },
      settings: { data: { defaultTimeoutMs: 600000, defaultConcurrency: { policy: 'limited', limit: 2 }, logRetention: { maxRunsPerTask: 50, maxAgeDays: 10 }, updatedAt: timestamp } }
    } }
  }
}

/** Initializes the fixed formal directories and versioned metadata files used by transaction tests. */
function initializeFormalData(root, current) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
  for (const name of ['scripts', 'tasks', 'environments']) fs.writeFileSync(path.join(root, 'data', `${name}.json`), JSON.stringify({ schemaVersion: 1, data: current[name] }))
  fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({ schemaVersion: 1, data: current.settings }))
  fs.writeFileSync(path.join(root, 'data', 'run-records.json'), JSON.stringify({ schemaVersion: 1, data: [{ id: 'history-canary' }] }))
  fs.writeFileSync(path.join(root, 'scripts', `${SCRIPT_ID}.js`), SOURCE)
}

test('builds merge and overwrite targets by stable ID while preserving device-only values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-target-'))
  try {
    const { current, snapshot } = createFixture(root)
    const merge = buildImportTarget(snapshot, current, 'merge')
    const overwrite = buildImportTarget(snapshot, current, 'overwrite')
    for (const target of [merge, overwrite]) {
      assert.equal(target.tasks[0].interpreter.executable, '/local/node')
      assert.equal(target.tasks[0].workingDirectory, '/local/work')
      assert.equal(target.tasks[0].enabled, true)
      assert.equal(target.environments[0].value, 'local-secret')
      assert.equal(target.settings.defaultInterpreters.javascript, '/default/node')
      assert.equal(target.settings.defaultWorkingDirectory, '/default/work')
      assert.equal(target.settings.defaultTimeoutMs, 600000)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('uses portable interpreter commands when a clean device has no local default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-portable-interpreter-'))
  try {
    const { current, snapshot } = createFixture(root)
    const cleanCurrent = {
      ...current,
      tasks: [],
      settings: {
        ...current.settings,
        defaultInterpreters: { javascript: null, python: null, powershell: null, shell: null }
      }
    }
    const target = buildImportTarget(snapshot, cleanCurrent, 'overwrite')
    assert.equal(target.tasks[0].interpreter.executable, 'node')
    assert.equal(target.tasks[0].enabled, false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('merge retains different stable IDs even when scripts and tasks share display names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-stable-id-'))
  try {
    const { current, snapshot } = createFixture(root)
    snapshot.documents.scripts.data[0].id = '123e4567-e89b-42d3-a456-426614174099'
    snapshot.documents.scripts.data[0].managedFileName = '123e4567-e89b-42d3-a456-426614174099.js'
    snapshot.documents.scripts.data[0].name = current.scripts[0].name
    snapshot.documents.tasks.data[0].id = '123e4567-e89b-42d3-a456-426614174098'
    snapshot.documents.tasks.data[0].scriptId = snapshot.documents.scripts.data[0].id
    snapshot.documents.tasks.data[0].name = current.tasks[0].name
    snapshot.documents.environments.data = []
    const target = buildImportTarget(snapshot, current, 'merge')
    assert.deepEqual(target.scripts.map(script => script.id), [SCRIPT_ID, '123e4567-e89b-42d3-a456-426614174099'])
    assert.deepEqual(target.tasks.map(task => task.id), [TASK_ID, '123e4567-e89b-42d3-a456-426614174098'])
    assert.equal(target.scripts.filter(script => script.name === 'script').length, 2)
    assert.equal(target.tasks.filter(task => task.name === 'task').length, 2)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('keeps omitted environment values for matching IDs and initializes new definitions empty', () => {
  const imported = [
    { id: 'same', name: 'A', value: '', valueIncluded: false },
    { id: 'new', name: 'B', value: '', valueIncluded: false }
  ]
  const result = materializeEnvironments(imported, [{ id: 'same', value: 'preserved' }])
  assert.equal(result[0].value, 'preserved')
  assert.equal(result[1].value, '')
  assert.equal(Object.hasOwn(result[0], 'valueIncluded'), false)
})

test('leaves all formal bytes unchanged when validation fails before transaction swaps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-rollback-'))
  try {
    const { current, snapshot } = createFixture(root)
    initializeFormalData(root, current)
    const beforeData = Object.fromEntries(fs.readdirSync(path.join(root, 'data')).map(name => [name, fs.readFileSync(path.join(root, 'data', name))]))
    const beforeScript = fs.readFileSync(path.join(root, 'scripts', `${SCRIPT_ID}.js`))
    fs.writeFileSync(path.join(snapshot.temporaryDirectory, 'scripts', `${SCRIPT_ID}.js`), 'tampered')
    const target = buildImportTarget(snapshot, current, 'overwrite')
    assert.throws(() => commitImportTarget(root, snapshot, target), error => error.code === 'HASH_MISMATCH')
    for (const [name, content] of Object.entries(beforeData)) assert.deepEqual(fs.readFileSync(path.join(root, 'data', name)), content)
    assert.deepEqual(fs.readFileSync(path.join(root, 'scripts', `${SCRIPT_ID}.js`)), beforeScript)
    const transactions = path.join(root, '.transactions')
    assert.deepEqual(fs.existsSync(transactions) ? fs.readdirSync(transactions) : [], [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('commits complete metadata and script targets while preserving run history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-transaction-'))
  try {
    const { current, snapshot } = createFixture(root)
    initializeFormalData(root, current)
    const target = buildImportTarget(snapshot, current, 'overwrite')
    commitImportTarget(root, snapshot, target)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'scripts.json'))).data[0].name, 'imported script')
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'tasks.json'))).data[0].name, 'imported task')
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'environments.json'))).data[0].value, 'local-secret')
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'run-records.json'))).data[0].id, 'history-canary')
    assert.equal(fs.readFileSync(path.join(root, 'scripts', `${SCRIPT_ID}.js`), 'utf8'), SOURCE)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
