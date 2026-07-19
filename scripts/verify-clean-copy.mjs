import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { hashDirectory, ROOT, sha256 } from './build-lib.mjs'

const EXCLUDED_NAMES = new Set(['.claude', '.git', 'dist', 'dist.staging', 'node_modules', 'release'])

/** Copies the current source tree to a repository-external directory while excluding generated and private state. */
function copySourceTree(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    filter(current) {
      const relative = path.relative(source, current)
      if (!relative) return true
      return !relative.split(path.sep).some(segment => EXCLUDED_NAMES.has(segment) || segment === '.DS_Store')
    }
  })
}

/** Runs one clean-copy command with inherited output and fails immediately on a non-zero exit. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, NODE_PATH: '' } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`)
}

/** Returns the platform-specific npm launcher so clean verification also works under Windows cmd shims. */
function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** Builds one source copy with no prior dependencies or output and returns its stable dist digest. */
function buildCleanDist(sourceRoot, parentDirectory, name) {
  const copyRoot = path.join(parentDirectory, name)
  copySourceTree(sourceRoot, copyRoot)
  if (fs.existsSync(path.join(copyRoot, 'node_modules')) || fs.existsSync(path.join(copyRoot, 'dist'))) {
    throw new Error('Clean copy contains generated state')
  }
  run(npmCommand(), ['ci', '--ignore-scripts'], copyRoot)
  run(npmCommand(), ['run', 'build'], copyRoot)
  const hashes = hashDirectory(path.join(copyRoot, 'dist'))
  const serializedHashes = JSON.stringify(hashes)
  return { copyRoot, distSha256: sha256(Buffer.from(serializedHashes)), serializedHashes }
}

/** Builds two clean copies and asserts file-for-file identical dist directories for reproducibility. */
async function main() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-clean-build-'))
  try {
    const first = buildCleanDist(ROOT, parent, 'first')
    const second = buildCleanDist(ROOT, parent, 'second')
    if (first.serializedHashes !== second.serializedHashes) throw new Error('Clean dist builds are not deterministic')
    console.log(JSON.stringify({
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      npm: spawnSync(npmCommand(), ['--version'], { encoding: 'utf8' }).stdout.trim(),
      sourceState: 'working-tree-copy',
      distSha256: first.distSha256,
      deterministicBuilds: 2,
      windowsZToolsArtifactVerification: 'pending'
    }, null, 2))
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
}

await main()
