'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  LogFileRepository,
  ManagedScriptRepository,
  calculateSha256
} = require('../public/preload/file-repositories')

const SCRIPT_ID = '123e4567-e89b-42d3-a456-426614174000'
const RUN_ID = '123e4567-e89b-42d3-a456-426614174001'

/** Creates isolated script and log repositories and removes their files after the test. */
function createFileRepositoryFixture(t, maxChunkBytes = 8) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-files-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    scripts: new ManagedScriptRepository(path.join(directory, 'scripts')),
    logs: new LogFileRepository(path.join(directory, 'logs'), maxChunkBytes)
  }
}

test('stores managed source under a controlled filename with a content hash', (t) => {
  const { scripts } = createFileRepositoryFixture(t)
  const content = 'console.log("你好")\n'
  const result = scripts.write(SCRIPT_ID, 'javascript', content)

  assert.equal(result.managedFileName, `${SCRIPT_ID}.js`)
  assert.equal(result.contentHash, calculateSha256(content))
  assert.equal(scripts.read(SCRIPT_ID, 'javascript'), content)
  assert.equal(scripts.exists(SCRIPT_ID, 'javascript'), true)
})

test('rejects arbitrary path fragments and unsupported script languages', (t) => {
  const { scripts } = createFileRepositoryFixture(t)
  assert.throws(() => scripts.write('../escape', 'javascript', 'x'), error => error.code === 'INVALID_ID')
  assert.throws(() => scripts.write(SCRIPT_ID, 'ruby', 'x'), error => error.code === 'VALIDATION_ERROR')
})

test('reconstructs UTF-8 logs across bounded byte chunks without replacement characters', (t) => {
  const { logs } = createFileRepositoryFixture(t, 7)
  const expected = 'stdout\n错误\n'
  logs.create(RUN_ID)
  logs.append(RUN_ID, 'stdout\n')
  logs.append(RUN_ID, '错误\n')

  let offset = 0
  let reconstructed = ''
  while (true) {
    const chunk = logs.readChunk(RUN_ID, offset, 7)
    assert.equal(chunk.content.includes('�'), false)
    reconstructed += chunk.content
    offset = chunk.nextOffset
    if (chunk.end) break
  }
  assert.equal(reconstructed, expected)
})

test('enforces log chunk bounds and controlled run IDs', (t) => {
  const { logs } = createFileRepositoryFixture(t, 8)
  logs.create(RUN_ID)
  assert.throws(() => logs.readChunk(RUN_ID, 0, 9), error => error.code === 'VALIDATION_ERROR')
  assert.throws(() => logs.create('../escape'), error => error.code === 'INVALID_ID')
})
