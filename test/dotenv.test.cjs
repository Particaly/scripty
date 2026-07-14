'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createEnvironmentsApi, parseDotEnv } = require('../public/preload/environment-service')
const { MetadataRepository } = require('../public/preload/metadata-repository')

test('parses dotenv comments, export syntax, quotes, and rejects duplicate names', () => {
  assert.deepEqual(parseDotEnv('# note\nexport A=one\nB="two words"\n'), [{ name: 'A', value: 'one' }, { name: 'B', value: 'two words' }])
  assert.throws(() => parseDotEnv('A=1\nA=2'), error => error.code === 'NAME_CONFLICT')
})

test('imports by preview token and requires explicit sensitive export permission', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-dotenv-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, '.env'); const target = path.join(root, 'saved.env')
  fs.writeFileSync(source, 'PUBLIC=hello\nSECRET="two words"\n')
  const metadata = new MetadataRepository(path.join(root, 'data')); metadata.initialize()
  const ztools = { showOpenDialog: () => [source], showSaveDialog: () => target }
  const api = createEnvironmentsApi(metadata, ztools)
  const preview = await api.chooseDotEnvImport(); assert.equal(preview.ok, true); assert.equal(preview.data.entries.length, 2)
  const imported = await api.importDotEnv(preview.data.previewToken, { scope: 'global', taskId: null, sensitive: true, overwriteExisting: true })
  assert.equal(imported.ok, true); assert.equal(imported.data.created, 2)
  const blocked = await api.exportDotEnv({ includeSensitiveValues: false }); assert.equal(blocked.ok, false)
  const exported = await api.exportDotEnv({ includeSensitiveValues: true }); assert.equal(exported.ok, true); assert.equal(exported.data.containsSensitiveValues, true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'PUBLIC=hello\nSECRET="two words"\n')
})
