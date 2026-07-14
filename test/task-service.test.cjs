'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { ManagedScriptRepository } = require('../public/preload/file-repositories')
const { MetadataRepository } = require('../public/preload/metadata-repository')
const { createTasksApi } = require('../public/preload/task-service')

const SCRIPT_ID = '123e4567-e89b-42d3-a456-426614174020'
const TASK_ID = '123e4567-e89b-42d3-a456-426614174010'
const RESOLVED_NODE = '/fixture/bin/node'
const interpreterResolver = { resolve: () => RESOLVED_NODE }

/** Creates persistent metadata, managed scripts, and deterministic interpreter resolution for the task API. */
function createTaskApiFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-tasks-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const metadata = new MetadataRepository(path.join(directory, 'data'))
  const scripts = new ManagedScriptRepository(path.join(directory, 'scripts'))
  metadata.initialize()
  scripts.write(SCRIPT_ID, 'javascript', 'console.log("ok")\n')
  metadata.write('scripts', [{
    id: SCRIPT_ID,
    name: 'backup.js',
    managedFileName: `${SCRIPT_ID}.js`,
    language: 'javascript',
    contentHash: 'fixture',
    note: '',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z'
  }])
  metadata.write('tasks', [{
    id: TASK_ID,
    name: '每日备份',
    note: '中文目录',
    scriptId: SCRIPT_ID,
    interpreter: { kind: 'javascript', executable: 'node' },
    args: [],
    workingDirectory: null,
    cron: '0 2 * * *',
    timeoutMs: null,
    enabled: true,
    concurrency: { policy: 'forbid', limit: 1 },
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z'
  }])
  return { api: createTasksApi(metadata, scripts, undefined, interpreterResolver), metadata }
}

test('coordinates task persistence with committed scheduler hot updates', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-task-scheduler-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const metadata = new MetadataRepository(path.join(directory, 'data'))
  const scripts = new ManagedScriptRepository(path.join(directory, 'scripts'))
  metadata.initialize()
  scripts.write(SCRIPT_ID, 'javascript', 'console.log("ok")')
  metadata.write('scripts', [{ id: SCRIPT_ID, name: 'scheduled.js', managedFileName: `${SCRIPT_ID}.js`, language: 'javascript', contentHash: 'fixture', note: '', createdAt: '', updatedAt: '' }])
  const entries = new Map()
  const calls = []
  const scheduler = {
    prepareTask(task) { calls.push(['prepare', task.id, task.enabled]); return { task, state: 'prepared' } },
    prepareRemoval(id) { calls.push(['prepareRemoval', id]); return { id, state: 'prepared' } },
    commit(change) { calls.push(['commit', change.task?.id ?? change.id]); if (change.task?.enabled && change.task.cron) entries.set(change.task.id, '2026-07-12T01:00:00.000Z'); else entries.delete(change.task?.id ?? change.id) },
    abort(change) { calls.push(['abort', change.task?.id ?? change.id]) },
    getNextRunAt(id) { return entries.get(id) ?? null }
  }
  const api = createTasksApi(metadata, scripts, scheduler, interpreterResolver)
  const draft = { name: '计划任务', note: '', scriptId: SCRIPT_ID, interpreter: { kind: 'javascript', executable: 'node' }, args: [], workingDirectory: null, cron: '0 * * * *', timeoutMs: null, enabled: true, concurrency: { policy: 'forbid', limit: 1 } }
  const created = await api.create(draft)
  assert.equal(created.ok, true)
  assert.equal(created.data.nextRunAt, '2026-07-12T01:00:00.000Z')
  assert.deepEqual(calls.slice(0, 2).map(call => call[0]), ['prepare', 'commit'])
  const disabled = await api.setEnabled(created.data.id, false)
  assert.equal(disabled.ok, true)
  assert.equal(disabled.data.nextRunAt, null)
  await api.remove(created.data.id)
  assert.equal(calls.at(-2)[0], 'prepareRemoval')
  assert.equal(calls.at(-1)[0], 'commit')
})

test('aborts a prepared schedule when metadata persistence fails', async (t) => {
  const { api, metadata } = createTaskApiFixture(t)
  const originalWrite = metadata.write.bind(metadata)
  let aborted = false
  const scheduler = { prepareTask: task => ({ task, state: 'prepared' }), prepareRemoval: id => ({ id, state: 'prepared' }), commit() {}, abort() { aborted = true }, getNextRunAt: () => null }
  const scheduledApi = createTasksApi(metadata, { exists: () => true }, scheduler, interpreterResolver)
  metadata.write = (name, data) => { if (name === 'tasks') throw new Error('write failed'); return originalWrite(name, data) }
  const source = (await api.get(TASK_ID)).data
  const result = await scheduledApi.update(TASK_ID, { ...source, name: '不会保存' })
  assert.equal(result.ok, false)
  assert.equal(aborted, true)
  metadata.write = originalWrite
  assert.equal(metadata.read('tasks')[0].name, '每日备份')
})

test('lists derived task summaries and filters them without exposing repository paths', async (t) => {
  const { api } = createTaskApiFixture(t)
  const result = await api.list({ search: '中文', enabled: true, readiness: 'ready' })
  assert.equal(result.ok, true)
  assert.equal(result.data.length, 1)
  assert.equal(result.data[0].scriptName, 'backup.js')
  assert.equal(result.data[0].readiness, 'ready')
  assert.equal(Object.hasOwn(result.data[0], 'scriptPath'), false)
})

test('derives interpreter readiness through the injected resolver without persisting device paths', async (t) => {
  const { api, metadata } = createTaskApiFixture(t)
  const ready = await api.list({ readiness: 'ready' })
  assert.equal(ready.ok, true)
  assert.equal(ready.data.length, 1)
  assert.equal(metadata.read('tasks')[0].interpreter.executable, 'node')

  const unavailableApi = createTasksApi(metadata, { exists: () => true }, undefined, { resolve: () => null })
  const unavailable = await unavailableApi.list({ readiness: 'interpreter_unavailable' })
  assert.equal(unavailable.ok, true)
  assert.equal(unavailable.data.length, 1)
  const draft = { ...metadata.read('tasks')[0] }
  const validated = await unavailableApi.validate(draft)
  assert.equal(validated.ok, true)
  assert.equal(validated.data.valid, false)
  assert.equal(validated.data.readiness, 'interpreter_unavailable')
})

test('creates, edits, duplicates, and removes tasks with stable identity rules', async (t) => {
  const { api, metadata } = createTaskApiFixture(t)
  const draft = {
    name: '新任务',
    note: '',
    scriptId: SCRIPT_ID,
    interpreter: { kind: 'javascript', executable: 'node' },
    args: [],
    workingDirectory: null,
    cron: null,
    timeoutMs: null,
    enabled: true,
    concurrency: { policy: 'forbid', limit: 1 }
  }
  const created = await api.create(draft)
  assert.equal(created.ok, true)
  assert.notEqual(created.data.id, TASK_ID)

  const updated = await api.update(created.data.id, { ...draft, name: '已编辑任务' })
  assert.equal(updated.ok, true)
  assert.equal(updated.data.name, '已编辑任务')

  const duplicated = await api.duplicate(created.data.id)
  assert.equal(duplicated.ok, true)
  assert.equal(duplicated.data.enabled, false)
  assert.match(duplicated.data.name, /副本$/)

  const removed = await api.remove(created.data.id)
  assert.equal(removed.ok, true)
  assert.equal(metadata.read('tasks').some(task => task.id === created.data.id), false)
})

test('rejects invalid drafts and deletion while task-scoped variables still reference a task', async (t) => {
  const { api, metadata } = createTaskApiFixture(t)
  const invalid = await api.create({ name: '', scriptId: 'missing' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'VALIDATION_ERROR')
  assert.ok(invalid.error.fieldErrors.name)

  metadata.write('environments', [{ id: 'env', taskId: TASK_ID }])
  const blocked = await api.remove(TASK_ID)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'REFERENCE_CONFLICT')
  assert.equal(metadata.read('tasks').length, 1)
})

test('preserves structured arguments, working directory, timeout, and notes without shell parsing', async (t) => {
  const { api, metadata } = createTaskApiFixture(t)
  const draft = {
    name: '参数任务',
    note: '中文备注',
    scriptId: SCRIPT_ID,
    interpreter: { kind: 'javascript', executable: 'node' },
    args: ['--output', '包含 空格', '&& echo unsafe'],
    workingDirectory: '/tmp/含 空格',
    cron: null,
    timeoutMs: 45000,
    enabled: false,
    concurrency: { policy: 'forbid', limit: 1 }
  }
  const result = await api.create(draft)
  assert.equal(result.ok, true)
  const stored = metadata.read('tasks').find(task => task.id === result.data.id)
  assert.deepEqual(stored.args, draft.args)
  assert.equal(stored.workingDirectory, draft.workingDirectory)
  assert.equal(stored.timeoutMs, 45000)
  assert.equal(stored.note, '中文备注')
})

test('rejects timeout and argument values outside documented bounds', async (t) => {
  const { api } = createTaskApiFixture(t)
  const base = { name: '边界', note: '', scriptId: SCRIPT_ID, interpreter: { kind: 'javascript', executable: 'node' }, args: [], workingDirectory: null, cron: null, timeoutMs: null, enabled: false, concurrency: { policy: 'forbid', limit: 1 } }
  const timeout = await api.create({ ...base, timeoutMs: 999 })
  assert.equal(timeout.ok, false)
  assert.ok(timeout.error.fieldErrors.timeoutMs)
  const args = await api.create({ ...base, args: Array(101).fill('x') })
  assert.equal(args.ok, false)
  assert.ok(args.error.fieldErrors.args)
})

test('supports common five-field Cron forms and rejects optional seconds or missing fields', async (t) => {
  const { api } = createTaskApiFixture(t)
  const commonExpressions = [
    '* * * * *',
    '*/5 * * * *',
    '0 9 * * 1-5',
    '0 9,17 * * *',
    '15 8 1 * *',
    '0 0 * JAN MON'
  ]

  for (const cron of commonExpressions) {
    const preview = await api.previewSchedule(cron)
    assert.equal(preview.ok, true, cron)
    assert.equal(preview.data.cron, cron)
    assert.equal(preview.data.nextRuns.length, 5)
    assert.ok(preview.data.nextRuns.every(value => !Number.isNaN(Date.parse(value))))
    assert.deepEqual(preview.data.nextRuns, [...preview.data.nextRuns].sort())
  }

  const normalized = await api.previewSchedule('  0 * * * *  ')
  assert.equal(normalized.ok, true)
  assert.equal(normalized.data.cron, '0 * * * *')

  for (const cron of ['', '   ', '* * * *', '0 * * * * *', '60 * * * *', '0 24 * * *', '*/0 * * * *', 'invalid * * * *']) {
    const result = await api.previewSchedule(cron)
    assert.equal(result.ok, false, cron)
    assert.equal(result.error.code, 'INVALID_CRON')
  }
})

test('validates managed source, interpreter, and Cron with the production parser', async (t) => {
  const { api } = createTaskApiFixture(t)
  const base = { name: '校验', note: '', scriptId: SCRIPT_ID, interpreter: { kind: 'javascript', executable: 'node' }, args: [], workingDirectory: null, cron: '*/5 * * * *', timeoutMs: null, enabled: false, concurrency: { policy: 'forbid', limit: 1 } }
  const valid = await api.validate(base)
  assert.equal(valid.ok, true)
  assert.equal(valid.data.readiness, 'ready')
  const preview = await api.previewSchedule('*/5 * * * *')
  assert.equal(preview.ok, true)
  assert.equal(preview.data.nextRuns.length, 5)
  const invalid = await api.validate({ ...base, cron: '99 * * * *' })
  assert.equal(invalid.ok, false)
  assert.ok(invalid.error.fieldErrors.cron)
  const missingInterpreter = await api.validate({ ...base, interpreter: { kind: 'javascript', executable: '' } })
  assert.equal(missingInterpreter.ok, false)
  assert.ok(missingInterpreter.error.fieldErrors['interpreter.executable'])
})

test('atomically persists enable changes and rejects invalid IDs', async (t) => {
  const { api, metadata } = createTaskApiFixture(t)
  const changed = await api.setEnabled(TASK_ID, false)
  assert.equal(changed.ok, true)
  assert.equal(changed.data.enabled, false)
  assert.equal(metadata.read('tasks')[0].enabled, false)

  const rejected = await api.setEnabled('../escape', true)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'INVALID_ID')
})
