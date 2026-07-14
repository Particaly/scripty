'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { MetadataRepository } = require('../public/preload/metadata-repository')
const { createSettingsApi } = require('../public/preload/settings-service')

/** Creates isolated settings metadata and a selectable executable fixture. */
function createSettingsFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-settings-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const executable = path.join(directory, 'node.exe')
  fs.writeFileSync(executable, 'fixture')
  const metadata = new MetadataRepository(path.join(directory, 'data'))
  metadata.initialize()
  return { metadata, executable, ztools: { showOpenDialog: () => [executable] } }
}

test('persists command-based defaults for all four supported languages', async (t) => {
  const { metadata, ztools } = createSettingsFixture(t)
  const api = createSettingsApi(metadata, ztools)
  const current = metadata.read('settings')
  const updated = await api.update({ ...current, defaultInterpreters: { javascript: 'node', python: 'python3', powershell: 'pwsh', shell: 'bash' } })
  assert.equal(updated.ok, true)
  assert.deepEqual(updated.data.defaultInterpreters, { javascript: 'node', python: 'python3', powershell: 'pwsh', shell: 'bash' })
})

test('selects an interpreter by single-use token and saves its verified local file', async (t) => {
  const { metadata, executable, ztools } = createSettingsFixture(t)
  const api = createSettingsApi(metadata, ztools)
  const selected = await api.chooseInterpreter('javascript')
  assert.equal(selected.ok, true)
  assert.equal(JSON.stringify(selected.data).includes(executable), false)
  const verified = await api.validateInterpreter('javascript', selected.data.selectionToken)
  assert.equal(verified.ok, true)
  assert.equal(metadata.read('settings').defaultInterpreters.javascript, executable)
  const reused = await api.validateInterpreter('javascript', selected.data.selectionToken)
  assert.equal(reused.ok, false)
  assert.equal(reused.error.code, 'TOKEN_INVALID')
})
