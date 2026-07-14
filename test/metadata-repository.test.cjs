'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  MetadataRepository,
  RepositoryError
} = require('../public/preload/metadata-repository')
const { MigrationRegistry } = require('../public/preload/migrations')

/** Creates an isolated metadata directory and removes it after the test finishes. */
function createRepositoryFixture(t, migrationRegistry) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-metadata-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return new MetadataRepository(directory, migrationRegistry)
}

test('initializes every metadata file without replacing existing data', (t) => {
  const repository = createRepositoryFixture(t)
  const initial = repository.initialize()
  assert.deepEqual(initial.scripts, [])
  assert.equal(initial.settings.defaultTimeoutMs, 300000)

  repository.write('tasks', [{ id: 'task-1' }])
  assert.deepEqual(repository.initialize().tasks, [{ id: 'task-1' }])
})

test('preserves corrupted JSON instead of silently restoring defaults', (t) => {
  const repository = createRepositoryFixture(t)
  repository.initialize()
  const filePath = repository.getFilePath('tasks')
  fs.writeFileSync(filePath, '{broken json', 'utf8')

  assert.throws(
    () => repository.initialize(),
    (error) => error instanceof RepositoryError && error.code === 'DATA_CORRUPTED'
  )
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken json')
})

test('migrates sequentially and writes back only a valid current envelope', (t) => {
  const migrations = new MigrationRegistry()
  migrations.register('scripts', 0, envelope => ({
    schemaVersion: 1,
    data: envelope.data.map(item => ({ ...item, note: item.note ?? '' }))
  }))
  const repository = createRepositoryFixture(t, migrations)
  repository.initialize()
  const filePath = repository.getFilePath('scripts')
  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 0, data: [{ id: 'legacy' }] }), 'utf8')

  assert.deepEqual(repository.read('scripts'), [{ id: 'legacy', note: '' }])
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).schemaVersion, 1)
})

test('does not modify data when a migration step is missing or the version is newer', (t) => {
  const repository = createRepositoryFixture(t)
  repository.initialize()
  const filePath = repository.getFilePath('tasks')

  for (const fixture of [
    { schemaVersion: 0, expectedCode: 'MIGRATION_FAILED' },
    { schemaVersion: 2, expectedCode: 'UNSUPPORTED_DATA_VERSION' }
  ]) {
    const content = JSON.stringify({ schemaVersion: fixture.schemaVersion, data: [] })
    fs.writeFileSync(filePath, content, 'utf8')
    assert.throws(() => repository.read('tasks'), error => error.code === fixture.expectedCode)
    assert.equal(fs.readFileSync(filePath, 'utf8'), content)
  }
})
