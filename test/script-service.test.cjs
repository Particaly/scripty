'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { ManagedScriptRepository } = require('../public/preload/file-repositories')
const { MetadataRepository } = require('../public/preload/metadata-repository')
const { createScriptsApi } = require('../public/preload/script-service')

/** Creates a selected source fixture and an isolated managed repository for import tests. */
function createScriptImportFixture(t, sourceName = '原始 脚本.js') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-import-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const sourcePath = path.join(directory, sourceName)
  fs.writeFileSync(sourcePath, 'console.log("托管副本")\n', 'utf8')
  const metadata = new MetadataRepository(path.join(directory, 'data'))
  const scripts = new ManagedScriptRepository(path.join(directory, 'managed'))
  metadata.initialize()
  const ztools = { showOpenDialog: () => [sourcePath] }
  return { directory, sourcePath, metadata, scripts, ztools }
}

test('returns a token without exposing the selected source path and imports an independent copy', async (t) => {
  const fixture = createScriptImportFixture(t)
  const api = createScriptsApi(fixture.metadata, fixture.scripts, fixture.ztools)
  const selected = await api.chooseImportFile()
  assert.equal(selected.ok, true)
  assert.equal(selected.data.displayName, '原始 脚本.js')
  assert.equal(JSON.stringify(selected.data).includes(fixture.sourcePath), false)

  const imported = await api.importSelected(selected.data.selectionToken, {
    name: '托管脚本', language: 'javascript', note: '测试'
  })
  assert.equal(imported.ok, true)
  fs.rmSync(fixture.sourcePath)
  assert.equal(fixture.scripts.read(imported.data.id, 'javascript'), 'console.log("托管副本")\n')
})

test('editing a managed import never writes back to its original external source', async (t) => {
  const fixture = createScriptImportFixture(t)
  const originalContent = fs.readFileSync(fixture.sourcePath, 'utf8')
  const api = createScriptsApi(fixture.metadata, fixture.scripts, fixture.ztools)
  const selected = await api.chooseImportFile()
  const imported = await api.importSelected(selected.data.selectionToken, { name: '隔离副本', language: 'javascript', note: '' })
  const updated = await api.update(imported.data.id, { name: '隔离副本', language: 'javascript', content: 'console.log("仅修改副本")\n', note: '' })
  assert.equal(updated.ok, true)
  assert.equal(fs.readFileSync(fixture.sourcePath, 'utf8'), originalContent)
  assert.equal(fixture.scripts.read(imported.data.id, 'javascript'), 'console.log("仅修改副本")\n')

  fs.writeFileSync(fixture.sourcePath, 'console.log("仅修改源文件")\n', 'utf8')
  assert.equal(fixture.scripts.read(imported.data.id, 'javascript'), 'console.log("仅修改副本")\n')
})

test('creates and updates managed source while preserving language and identity', async (t) => {
  const fixture = createScriptImportFixture(t)
  const api = createScriptsApi(fixture.metadata, fixture.scripts, fixture.ztools)
  const created = await api.create({ name: '内置脚本', language: 'python', content: 'print("一")\n', note: '' })
  assert.equal(created.ok, true)
  const id = created.data.id
  const updated = await api.update(id, { name: '内置脚本二', language: 'python', content: 'print("二")\n', note: '改' })
  assert.equal(updated.ok, true)
  assert.equal(updated.data.id, id)
  assert.equal(fixture.scripts.read(id, 'python'), 'print("二")\n')
  const rejected = await api.update(id, { name: '变语言', language: 'shell', content: 'echo x', note: '' })
  assert.equal(rejected.ok, false)
  assert.equal(fixture.scripts.read(id, 'python'), 'print("二")\n')
})

test('selection tokens are single-use and unsupported extensions are rejected', async (t) => {
  const fixture = createScriptImportFixture(t)
  const api = createScriptsApi(fixture.metadata, fixture.scripts, fixture.ztools)
  const selected = await api.chooseImportFile()
  await api.importSelected(selected.data.selectionToken, { name: '一次', language: 'javascript', note: '' })
  const reused = await api.importSelected(selected.data.selectionToken, { name: '两次', language: 'javascript', note: '' })
  assert.equal(reused.ok, false)
  assert.equal(reused.error.code, 'TOKEN_INVALID')

  const invalidFixture = createScriptImportFixture(t, 'payload.exe')
  const invalidApi = createScriptsApi(invalidFixture.metadata, invalidFixture.scripts, invalidFixture.ztools)
  const rejected = await invalidApi.chooseImportFile()
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'FILE_TYPE_NOT_ALLOWED')
})
