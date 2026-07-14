'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { createHistoryApi } = require('../public/preload/history-service')

/** Creates an in-memory history fixture with one record per supported trigger source. */
function fixture() {
  const records = ['manual', 'cron', 'retry'].map((trigger, index) => ({
    id: `run-${trigger}`,
    taskId: 'task-1',
    taskNameSnapshot: '任务',
    scriptNameSnapshot: 'script.js',
    trigger,
    startedAt: `2026-07-12T00:0${index}:00.000Z`,
    finishedAt: `2026-07-12T00:0${index}:01.000Z`,
    status: index === 2 ? 'failed' : 'success',
    exitCode: index === 2 ? 1 : 0,
    durationMs: 1000,
    logFileName: `${trigger}.log`,
    errorSummary: null
  }))
  const retryCalls = []
  const removedLogs = []
  let storedRecords = records.slice()
  const api = createHistoryApi(
    { read: name => name === 'runRecords' ? storedRecords : [], write(name, value) { if (name === 'runRecords') storedRecords = value } },
    { readChunk() { return { content: '', offset: 0, nextOffset: 0, end: true } }, getSize() { return 10 }, remove(id) { removedLogs.push(id) } },
    { async start(taskId, trigger) { retryCalls.push([taskId, trigger]); return { ok: true, data: { ...records[2], id: 'retried', trigger } } } }
  )
  return { api, removedLogs, retryCalls }
}

test('filters persisted history by manual and Cron trigger sources', async () => {
  const { api } = fixture()
  const manual = await api.list({ page: 1, pageSize: 20, trigger: 'manual' })
  const cron = await api.list({ page: 1, pageSize: 20, trigger: 'cron' })
  assert.deepEqual(manual.data.items.map(record => record.trigger), ['manual'])
  assert.deepEqual(cron.data.items.map(record => record.trigger), ['cron'])
})

test('filters by status, task, and text while paginating in reverse chronological order', async () => {
  const { api } = fixture()
  const failed = await api.list({ page: 1, pageSize: 1, status: 'failed', taskId: 'task-1', search: 'SCRIPT' })
  assert.equal(failed.data.total, 1)
  assert.equal(failed.data.items[0].id, 'run-retry')
  const newest = await api.list({ page: 1, pageSize: 2 })
  const older = await api.list({ page: 2, pageSize: 2 })
  assert.deepEqual(newest.data.items.map(record => record.id), ['run-retry', 'run-cron'])
  assert.deepEqual(older.data.items.map(record => record.id), ['run-manual'])
})

test('returns details and reads logs only for existing run IDs', async () => {
  const { api } = fixture()
  assert.equal((await api.get('run-cron')).data.trigger, 'cron')
  assert.equal((await api.get('missing')).error.code, 'NOT_FOUND')
  assert.equal((await api.readLog('run-manual', { offset: 0, length: 1024 })).data.end, true)
  assert.equal((await api.readLog('missing', { offset: 0, length: 1024 })).error.code, 'NOT_FOUND')
})

test('cleans history by task, age, or per-task count and reports removed log bytes', async () => {
  const byTask = fixture()
  const taskResult = await byTask.api.clear({ taskId: 'task-1' })
  assert.deepEqual(taskResult.data, { recordsRemoved: 3, logFilesRemoved: 3, bytesFreed: 30 })
  assert.deepEqual(byTask.removedLogs.sort(), ['run-cron', 'run-manual', 'run-retry'])
  assert.equal((await byTask.api.list({ page: 1, pageSize: 20 })).data.total, 0)

  const byCount = fixture()
  const countResult = await byCount.api.clear({ maxRunsPerTask: 1 })
  assert.equal(countResult.data.recordsRemoved, 2)
  assert.deepEqual((await byCount.api.list({ page: 1, pageSize: 20 })).data.items.map(record => record.id), ['run-retry'])

  const byAge = fixture()
  const ageResult = await byAge.api.clear({ olderThan: '2026-07-12T00:01:30.000Z' })
  assert.equal(ageResult.data.recordsRemoved, 2)
  assert.equal((await byAge.api.clear({})).error.code, 'VALIDATION_ERROR')
})

test('historical retry records a distinct retry trigger against current task configuration', async () => {
  const { api, retryCalls } = fixture()
  const result = await api.retry('run-manual')
  assert.equal(result.ok, true)
  assert.equal(result.data.trigger, 'retry')
  assert.deepEqual(retryCalls, [['task-1', 'retry']])
})
