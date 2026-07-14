import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const TEST_DIRECTORY = path.resolve('test')
const EXCLUDED = new Set(['release-artifact.test.cjs'])

/** Lists top-level CommonJS unit tests in stable order while excluding release tests that require a prior renderer build. */
function listUnitTests() {
  return fs.readdirSync(TEST_DIRECTORY, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.cjs') && !EXCLUDED.has(entry.name))
    .map(entry => path.join('test', entry.name))
    .sort()
}

/** Runs Node's test runner with explicit cross-platform file arguments and preserves its exit status. */
function main() {
  const result = spawnSync(process.execPath, ['--test', ...listUnitTests()], { stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

main()
