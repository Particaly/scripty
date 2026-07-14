import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, sha256 } from './release-lib.mjs'

const EXCLUDED_NAMES = new Set(['.claude', '.git', 'dist', 'node_modules', 'release'])

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

/** Produces a release in a source copy with no prior dependencies or build output and returns its ZIP digest. */
function buildCleanRelease(sourceRoot, parentDirectory, name) {
  const copyRoot = path.join(parentDirectory, name)
  copySourceTree(sourceRoot, copyRoot)
  if (fs.existsSync(path.join(copyRoot, 'node_modules')) || fs.existsSync(path.join(copyRoot, 'release'))) throw new Error('Clean copy contains generated state')
  run(npmCommand(), ['ci', '--ignore-scripts'], copyRoot)
  run(npmCommand(), ['run', 'build'], copyRoot)
  run(npmCommand(), ['test'], copyRoot)
  run(npmCommand(), ['run', 'test:release'], copyRoot)
  run('node', ['scripts/release.mjs'], copyRoot)
  run('node', ['scripts/verify-release.mjs'], copyRoot)
  run('node', ['scripts/smoke-renderer.mjs'], copyRoot)
  const packageJson = JSON.parse(fs.readFileSync(path.join(copyRoot, 'package.json'), 'utf8'))
  const artifactDirectory = path.join(copyRoot, 'release', `${packageJson.name}-${packageJson.version}`)
  const zipPath = path.join(copyRoot, 'release', `${packageJson.name}-${packageJson.version}.zip`)
  const sums = fs.readFileSync(path.join(copyRoot, 'release/SHA256SUMS'), 'utf8')
  fs.rmSync(path.join(copyRoot, 'node_modules'), { recursive: true, force: true })
  run('node', ['scripts/smoke-preload.mjs', artifactDirectory], copyRoot)
  return { copyRoot, zipPath, zipSha256: sha256(zipPath), sums }
}

/** Builds two clean copies and asserts byte-identical archives and file hash manifests for reproducibility. */
async function main() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'scripty-clean-release-'))
  try {
    const first = buildCleanRelease(ROOT, parent, 'first')
    const second = buildCleanRelease(ROOT, parent, 'second')
    if (first.zipSha256 !== second.zipSha256 || first.sums !== second.sums) throw new Error('Clean release builds are not deterministic')
    console.log(JSON.stringify({
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      npm: spawnSync(npmCommand(), ['--version'], { encoding: 'utf8' }).stdout.trim(),
      sourceState: 'working-tree-copy',
      zipSha256: first.zipSha256,
      deterministicBuilds: 2,
      preloadWithoutNodeModules: 'passed',
      rendererSmoke: 'passed',
      windowsZToolsArtifactVerification: 'pending'
    }, null, 2))
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
}

await main()
