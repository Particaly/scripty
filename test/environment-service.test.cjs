'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { buildTaskEnvironment, createEnvironmentsApi } = require('../public/preload/environment-service')
const { MetadataRepository } = require('../public/preload/metadata-repository')

/** Creates isolated metadata with one task for global and task-scoped CRUD tests. */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-env-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const metadata = new MetadataRepository(path.join(root, 'data')); metadata.initialize()
  metadata.write('tasks', [{ id: 'task-1' }])
  return { metadata, api: createEnvironmentsApi(metadata) }
}

test('merges global and task variables over system values with disabled entries ignored', () => {
  const merged = buildTaskEnvironment(
    { PATH: '/system', SHARED: 'system' },
    [
      { name: 'SHARED', value: 'global', scope: 'global', taskId: null, enabled: true },
      { name: 'GLOBAL_ONLY', value: 'yes', scope: 'global', taskId: null, enabled: true },
      { name: 'SHARED', value: 'task', scope: 'task', taskId: 'task-1', enabled: true },
      { name: 'DISABLED', value: 'hidden', scope: 'global', taskId: null, enabled: false },
      { name: 'OTHER', value: 'wrong', scope: 'task', taskId: 'task-2', enabled: true }
    ],
    'task-1'
  )
  assert.deepEqual(merged, { PATH: '/system', SHARED: 'task', GLOBAL_ONLY: 'yes' })
})

test('creates, lists, edits, and removes environment variables with masked sensitive summaries', async (t) => {
  const { api, metadata } = fixture(t)
  const created = await api.create({ name: 'API_TOKEN', value: 'secret', note: 'token', scope: 'global', taskId: null, enabled: true, sensitive: true })
  assert.equal(created.ok, true); assert.equal(created.data.maskedValue, '••••••••'); assert.equal(JSON.stringify(created.data).includes('secret'), false)
  const updated = await api.update(created.data.id, { name: 'API_TOKEN', value: 'new-secret', note: 'new', scope: 'global', taskId: null, enabled: false, sensitive: true })
  assert.equal(updated.ok, true); assert.equal(metadata.read('environments')[0].value, 'new-secret')
  assert.equal((await api.list()).data[0].maskedValue, '••••••••')
  const revealed = await api.reveal(created.data.id)
  assert.equal(revealed.ok, true); assert.equal(revealed.data.value, 'new-secret')
  const disabled = await api.setEnabled(created.data.id, false)
  assert.equal(disabled.ok, true); assert.equal(disabled.data.enabled, false); assert.equal(JSON.stringify(disabled.data).includes('new-secret'), false)
  assert.equal((await api.remove(created.data.id)).ok, true); assert.equal(metadata.read('environments').length, 0)
})

test('enforces name syntax, task references, and same-scope uniqueness', async (t) => {
  const { api } = fixture(t)
  assert.equal((await api.create({ name: 'bad-name', value: '', scope: 'global' })).error.code, 'VALIDATION_ERROR')
  assert.equal((await api.create({ name: 'X', value: '', scope: 'task', taskId: 'missing' })).error.code, 'REFERENCE_CONFLICT')
  await api.create({ name: 'X', value: '1', scope: 'task', taskId: 'task-1' })
  assert.equal((await api.create({ name: 'X', value: '2', scope: 'task', taskId: 'task-1' })).error.code, 'NAME_CONFLICT')
  assert.equal((await api.create({ name: 'X', value: 'global', scope: 'global' })).ok, true)
})
