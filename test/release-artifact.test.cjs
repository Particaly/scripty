const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.join(__dirname, '..')

/** Imports one ESM release helper relative to the CommonJS test suite. */
function importScript(relativePath) {
  return import(pathToFileURL(path.join(root, relativePath)).href)
}

/** Creates a temporary directory and registers deterministic recursive cleanup with the test runner. */
function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('derives a stable production manifest without mutating the development source', async () => {
  const { createProductionManifest } = await importScript('scripts/release-lib.mjs')
  const source = JSON.parse(fs.readFileSync(path.join(root, 'public/plugin.json'), 'utf8'))
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const production = createProductionManifest(source, packageJson.version)

  assert.equal('$schema' in production, false)
  assert.equal('development' in production, false)
  assert.equal(source.development.main, 'http://localhost:5173')
  assert.equal(source.$schema.includes('ztools.schema.json'), true)
  assert.equal(production.version, packageJson.version)
  assert.deepEqual(production.features.map(feature => feature.code), ['scripty', 'scripty-run-task', 'scripty-running'])
})

test('builds a self-contained release directory and a byte-matching deterministic ZIP', async (t) => {
  const { buildReleaseDirectory, hashDirectory, readZipEntries, sha256, writeReleaseZip } = await importScript('scripts/release-lib.mjs')
  const { verifyReleaseDirectory } = await importScript('scripts/verify-release.mjs')
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const temporary = temporaryDirectory(t, 'scripty-release-test-')
  const firstDirectory = path.join(temporary, 'first')
  const secondDirectory = path.join(temporary, 'second')
  const firstZip = path.join(temporary, 'first.zip')
  const secondZip = path.join(temporary, 'second.zip')

  await buildReleaseDirectory(firstDirectory)
  await buildReleaseDirectory(secondDirectory)
  const first = verifyReleaseDirectory(firstDirectory, packageJson)
  const second = verifyReleaseDirectory(secondDirectory, packageJson)
  await writeReleaseZip(firstDirectory, firstZip)
  await writeReleaseZip(secondDirectory, secondZip)

  assert.deepEqual(first.files, second.files)
  assert.deepEqual(hashDirectory(firstDirectory), hashDirectory(secondDirectory))
  assert.equal(sha256(firstZip), sha256(secondZip))
  const entries = await readZipEntries(firstZip)
  assert.deepEqual([...entries.keys()], first.files)
  for (const file of first.files) assert.deepEqual(entries.get(file), fs.readFileSync(path.join(firstDirectory, ...file.split('/'))))
  assert.equal(first.files.some(file => file.includes('node_modules') || file.endsWith('.map')), false)
  assert.deepEqual(first.files.filter(file => file.startsWith('preload/')), ['preload/package.json', 'preload/services.js'])
})

test('loads the bundled preload outside the repository and exercises Cron plus ZIP dependencies', async (t) => {
  const { buildReleaseDirectory } = await importScript('scripts/release-lib.mjs')
  const { smokePreload } = await importScript('scripts/smoke-preload.mjs')
  const temporary = temporaryDirectory(t, 'scripty-preload-smoke-test-')
  const directory = path.join(temporary, 'artifact')
  await buildReleaseDirectory(directory)
  const result = await smokePreload(directory)
  assert.equal(path.isAbsolute(result.userData), true)
  assert.equal(result.userData.startsWith(root), false)
})
